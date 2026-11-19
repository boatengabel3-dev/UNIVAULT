-- UniVault schema (fresh project). If you ran the old schema, drop those tables first.
create table questions(id uuid default gen_random_uuid() primary key,department text not null,course_code text not null,course_title text,description text,year int not null,semester int,uploader uuid references auth.users,status text default 'pending',created_at timestamptz default now());
create table question_content(question_id uuid primary key references questions on delete cascade,content text,content_hash text,file_url text);
create table profiles(id uuid primary key references auth.users on delete cascade,full_name text,balance int default 0,premium_until timestamptz,created_at timestamptz default now());
create table payments(reference text primary key,user_id uuid,amount int,created_at timestamptz default now());
create table payouts(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users,amount int,account_name text,momo text,network text,status text default 'pending',created_at timestamptz default now());
create table admins(user_id uuid primary key references auth.users on delete cascade);
alter table questions enable row level security;alter table question_content enable row level security;alter table profiles enable row level security;alter table payments enable row level security;alter table payouts enable row level security;alter table admins enable row level security;
create function is_admin() returns boolean language sql security definer stable set search_path = public as $$ select exists(select 1 from public.admins where user_id=auth.uid()) $$;
create function is_premium() returns boolean language sql security definer stable set search_path = public as $$ select exists(select 1 from public.profiles where id=auth.uid() and premium_until>now()) $$;
create policy "q read" on questions for select using(status='approved' or uploader=auth.uid() or is_admin());
create policy "content read" on question_content for select using(is_admin() or (is_premium() and exists(select 1 from questions q where q.id=question_id and q.status='approved')) or exists(select 1 from questions q where q.id=question_id and q.uploader=auth.uid()));
create policy "own profile" on profiles for select using(auth.uid()=id or is_admin());
create policy "admin payments" on payments for select using(is_admin());
create policy "own payouts" on payouts for select using(user_id=auth.uid() or is_admin());
create policy "am i admin" on admins for select using(user_id=auth.uid());
create or replace function public.new_profile() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into public.profiles(id,full_name) values(new.id,new.raw_user_meta_data->>'full_name') on conflict (id) do nothing; return new; end $$;
drop trigger if exists on_signup on auth.users;
create trigger on_signup after insert on auth.users for each row execute function public.new_profile();

-- Data normalization & duplicate prevention helpers
alter table if exists public.question_content add column if not exists content_hash text;
create or replace function public.normalize_code_key(c text) returns text language sql immutable as $$ select regexp_replace(upper(coalesce(c,'')), '[^A-Z0-9]', '', 'g') $$;
create or replace function public.normalize_body_hash(body text) returns text language sql immutable as $$ select md5(regexp_replace(lower(coalesce(body,'')), '[^a-z0-9]+', '', 'g')) $$;
update public.question_content set content_hash = public.normalize_body_hash(content) where content_hash is null and content is not null;

create or replace function public.check_question_duplicate(c text, y int default 0, s int default 0, body text default '') returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ckey text := public.normalize_code_key(c);
  bhash text := case when length(coalesce(body,'')) >= 30 then public.normalize_body_hash(body) else null end;
  found_q record;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if ckey <> '' and coalesce(y, 0) > 0 then
    select q.id, q.course_code, q.year, q.semester, q.status into found_q
    from public.questions q
    where q.status <> 'rejected'
      and public.normalize_code_key(q.course_code) = ckey
      and q.year = y
      and (coalesce(s, 0) = 0 or coalesce(q.semester, 0) = 0 or q.semester = s)
    limit 1;
    if found_q.id is not null then
      return jsonb_build_object(
        'duplicate', true,
        'match_id', found_q.id,
        'course_code', found_q.course_code,
        'year', found_q.year,
        'semester', found_q.semester,
        'status', found_q.status,
        'match_type', 'course_year_semester',
        'reason', format('Duplicate past question: %s (%s%s) already exists in UniVault (%s).', found_q.course_code, found_q.year, case when found_q.semester is not null then ' Sem '||found_q.semester else '' end, found_q.status)
      );
    end if;
  end if;

  if bhash is not null then
    select q.id, q.course_code, q.year, q.semester, q.status into found_q
    from public.question_content qc
    join public.questions q on q.id = qc.question_id
    where q.status <> 'rejected'
      and coalesce(qc.content_hash, public.normalize_body_hash(qc.content)) = bhash
    limit 1;
    if found_q.id is not null then
      return jsonb_build_object(
        'duplicate', true,
        'match_id', found_q.id,
        'course_code', found_q.course_code,
        'year', found_q.year,
        'semester', found_q.semester,
        'status', found_q.status,
        'match_type', 'exact_content',
        'reason', format('Duplicate content detected: This exact past question already exists under %s (%s%s).', found_q.course_code, found_q.year, case when found_q.semester is not null then ' Sem '||found_q.semester else '' end)
      );
    end if;
  end if;

  return jsonb_build_object('duplicate', false);
end $$;

create or replace function submit_question(d text,c text,t text,y int,s int,body text,descr text default null) returns void language plpgsql security definer set search_path = public as $$
declare
  qid uuid;
  clean_dep text := trim(regexp_replace(coalesce(d,''), '\s+', ' ', 'g'));
  clean_code text := upper(trim(regexp_replace(coalesce(c,''), '\s+', ' ', 'g')));
  clean_title text := trim(regexp_replace(coalesce(t,''), '\s+', ' ', 'g'));
  clean_body text := trim(coalesce(body,''));
  dup jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if length(clean_body)<50 then raise exception 'Question text is too short'; end if;
  dup := public.check_question_duplicate(clean_code, y, s, clean_body);
  if coalesce((dup->>'duplicate')::boolean, false) then
    raise exception '%', dup->>'reason';
  end if;
  insert into public.questions(department,course_code,course_title,description,year,semester,uploader) values(clean_dep,clean_code,clean_title,descr,y,s,auth.uid()) returning id into qid;
  insert into public.question_content(question_id,content,content_hash) values(qid,clean_body,public.normalize_body_hash(clean_body));
end $$;

create or replace function admin_publish_question(d text,c text,t text,y int,s int,body text,descr text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare
  qid uuid;
  clean_dep text := trim(regexp_replace(coalesce(d,''), '\s+', ' ', 'g'));
  clean_code text := upper(trim(regexp_replace(coalesce(c,''), '\s+', ' ', 'g')));
  clean_title text := trim(regexp_replace(coalesce(t,''), '\s+', ' ', 'g'));
  clean_body text := trim(coalesce(body,''));
  dup jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if length(clean_body)<20 then raise exception 'Question text is too short'; end if;
  dup := public.check_question_duplicate(clean_code, y, s, clean_body);
  if coalesce((dup->>'duplicate')::boolean, false) then
    raise exception '%', dup->>'reason';
  end if;
  insert into public.questions(department,course_code,course_title,description,year,semester,uploader,status) values(clean_dep,clean_code,clean_title,descr,y,s,auth.uid(),'approved') returning id into qid;
  insert into public.question_content(question_id,content,content_hash) values(qid,clean_body,public.normalize_body_hash(clean_body));
  return qid;
end $$;

-- approving credits the uploader GH₵3 (300 pesewas), once per question
create function approve_question(qid uuid) returns void language plpgsql security definer set search_path = public as $$
declare u uuid; begin if not public.is_admin() then raise exception 'forbidden'; end if;
update public.questions set status='approved' where id=qid and status='pending' returning uploader into u;
if u is not null then update public.profiles set balance=balance+300 where id=u; end if; end $$;
create function reject_question(qid uuid) returns void language plpgsql security definer set search_path = public as $$
begin if not public.is_admin() then raise exception 'forbidden'; end if; update public.questions set status='rejected' where id=qid and status='pending'; end $$;
create function request_payout(nm text,momo text,net text) returns void language plpgsql security definer set search_path = public as $$
declare b int; begin select balance into b from public.profiles where id=auth.uid() for update;
if coalesce(b,0)<1000 then raise exception 'Minimum payout is GH₵10'; end if;
update public.profiles set balance=0 where id=auth.uid();
insert into public.payouts(user_id,amount,account_name,momo,network) values(auth.uid(),b,nm,momo,net); end $$;
-- Student contributor testimonials
create table if not exists testimonials(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users on delete set null default auth.uid(),author_name text not null,role text not null,quote text not null,approved boolean default false,created_at timestamptz default now());
alter table testimonials enable row level security;
create policy "testimonials read" on testimonials for select using(approved=true or user_id=auth.uid() or is_admin());
create policy "testimonials insert" on testimonials for insert with check(char_length(trim(author_name))>=2 and char_length(trim(role))>=2 and char_length(trim(quote)) between 15 and 600 and (coalesce(approved,false)=false or is_admin()));
create policy "testimonials admin update" on testimonials for update using(is_admin());
create policy "testimonials admin delete" on testimonials for delete using(is_admin());
-- MAKE AN ADMIN (run in SQL editor with the user's id from Authentication > Users):
-- insert into admins(user_id) values('PASTE-USER-UUID') on conflict (user_id) do nothing;
