-- UniVault schema (safe to re-run on both fresh and existing Supabase projects).
create table if not exists questions(id uuid default gen_random_uuid() primary key,department text not null,course_code text not null,course_title text,description text,year int not null,semester int,uploader uuid references auth.users,status text default 'pending',created_at timestamptz default now());
alter table if exists public.questions add column if not exists description text;
create table if not exists question_content(question_id uuid primary key references questions on delete cascade,content text,content_hash text,file_url text);
create table if not exists profiles(id uuid primary key references auth.users on delete cascade,full_name text,programme_id text,programme text,balance int default 0,plan text not null default 'free',premium_started_at timestamptz,premium_expires_at timestamptz,premium_until timestamptz,created_at timestamptz default now());
alter table if exists public.profiles add column if not exists programme_id text;
alter table if exists public.profiles add column if not exists programme text;
alter table if exists public.profiles add column if not exists free_question_ids uuid[] not null default '{}';
alter table if exists public.profiles add column if not exists plan text not null default 'free';
alter table if exists public.profiles add column if not exists premium_started_at timestamptz;
alter table if exists public.profiles add column if not exists premium_expires_at timestamptz;
update public.profiles set premium_expires_at = coalesce(premium_expires_at, premium_until), plan = case when coalesce(premium_expires_at, premium_until) > now() then 'premium' else coalesce(nullif(plan, ''), 'free') end where (premium_expires_at is null and premium_until is not null) or plan is null;
create table if not exists payments(reference text primary key,user_id uuid,amount int,created_at timestamptz default now());
create table if not exists payouts(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users,amount int,account_name text,momo text,network text,status text default 'pending',created_at timestamptz default now());
create table if not exists admins(user_id uuid primary key references auth.users on delete cascade);
alter table questions enable row level security;alter table question_content enable row level security;alter table profiles enable row level security;alter table payments enable row level security;alter table payouts enable row level security;alter table admins enable row level security;
create or replace function is_admin() returns boolean language sql security definer stable set search_path = public as $$ select exists(select 1 from public.admins where user_id=auth.uid()) $$;
create or replace function is_premium() returns boolean language sql security definer stable set search_path = public as $$ select public.is_admin() or exists(select 1 from public.profiles where id=auth.uid() and coalesce(premium_expires_at, premium_until)>now()) $$;
drop policy if exists "q read" on questions;
create policy "q read" on questions for select using(status='approved' or uploader=auth.uid() or is_admin());
drop policy if exists "content read" on public.question_content;
create policy "content read" on question_content for select using(
  is_admin()
  or (is_premium() and exists(select 1 from questions q where q.id=question_id and q.status='approved'))
  or exists(select 1 from questions q where q.id=question_id and q.uploader=auth.uid())
  or (
    exists(select 1 from questions q where q.id=question_id and q.status='approved')
    and exists(select 1 from public.profiles p where p.id=auth.uid() and question_id = any(coalesce(p.free_question_ids, '{}')))
  )
);
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select using(auth.uid()=id or is_admin());
drop policy if exists "own profile programme update" on profiles;
create policy "own profile programme update" on profiles for update using(auth.uid()=id) with check(auth.uid()=id);
revoke update on public.profiles from anon, authenticated;
grant update (full_name, programme_id, programme) on public.profiles to authenticated;
drop policy if exists "admin payments" on payments;
drop policy if exists "own or admin payments" on payments;
create policy "own or admin payments" on payments for select using(user_id=auth.uid() or is_admin());
drop policy if exists "own payouts" on payouts;
create policy "own payouts" on payouts for select using(user_id=auth.uid() or is_admin());
drop policy if exists "am i admin" on admins;
create policy "am i admin" on admins for select using(user_id=auth.uid());
create or replace function public.new_profile() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into public.profiles(id,full_name,programme_id,programme) values(new.id,coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),nullif(trim(coalesce(new.raw_user_meta_data->>'programme_id','')),''),nullif(trim(coalesce(new.raw_user_meta_data->>'programme','')),'')) on conflict (id) do update set programme_id=coalesce(excluded.programme_id,public.profiles.programme_id),programme=coalesce(excluded.programme,public.profiles.programme); return new; end $$;
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

drop function if exists public.submit_question(text,text,text,int,int,text);
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

drop function if exists public.admin_publish_question(text,text,text,int,int,text);
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
create or replace function approve_question(qid uuid) returns void language plpgsql security definer set search_path = public as $$
declare u uuid; begin if not public.is_admin() then raise exception 'forbidden'; end if;
update public.questions set status='approved' where id=qid and status='pending' returning uploader into u;
if u is not null then update public.profiles set balance=balance+300 where id=u; end if; end $$;
create or replace function reject_question(qid uuid) returns void language plpgsql security definer set search_path = public as $$
begin if not public.is_admin() then raise exception 'forbidden'; end if; update public.questions set status='rejected' where id=qid and status='pending'; end $$;
create or replace function request_payout(nm text,momo text,net text) returns void language plpgsql security definer set search_path = public as $$
declare b int; begin select balance into b from public.profiles where id=auth.uid() for update;
if coalesce(b,0)<1000 then raise exception 'Minimum payout is GH₵10'; end if;
update public.profiles set balance=0 where id=auth.uid();
insert into public.payouts(user_id,amount,account_name,momo,network) values(auth.uid(),b,nm,momo,net); end $$;
-- Student contributor testimonials
create table if not exists testimonials(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users on delete set null default auth.uid(),author_name text not null,role text not null,quote text not null,approved boolean default false,created_at timestamptz default now());
alter table testimonials enable row level security;
drop policy if exists "testimonials read" on testimonials;
create policy "testimonials read" on testimonials for select using(approved=true or user_id=auth.uid() or is_admin());
drop policy if exists "testimonials insert" on testimonials;
create policy "testimonials insert" on testimonials for insert with check(char_length(trim(author_name))>=2 and char_length(trim(role))>=2 and char_length(trim(quote)) between 15 and 600 and (coalesce(approved,false)=false or is_admin()));
drop policy if exists "testimonials admin update" on testimonials;
create policy "testimonials admin update" on testimonials for update using(is_admin());
drop policy if exists "testimonials admin delete" on testimonials;
create policy "testimonials admin delete" on testimonials for delete using(is_admin());
-- Admin-configurable pricing & free tier allowances before Pro/Premium
alter table if exists public.profiles add column if not exists ai_uses int default 0;
alter table if exists public.profiles add column if not exists free_question_ids uuid[] not null default '{}';
create table if not exists public.app_settings(id int primary key default 1 check(id=1),price_ghs numeric(10,2) not null default 30,free_ai_limit int not null default 5,free_questions_limit int not null default 3,updated_at timestamptz default now());
alter table if exists public.app_settings add column if not exists free_questions_limit int not null default 3;
insert into public.app_settings(id,price_ghs,free_ai_limit,free_questions_limit) values(1,30,5,3) on conflict (id) do nothing;
alter table public.app_settings enable row level security;
drop policy if exists "settings public read" on public.app_settings;
create policy "settings public read" on public.app_settings for select using(true);
drop policy if exists "settings admin insert" on public.app_settings;
create policy "settings admin insert" on public.app_settings for insert with check(is_admin() and price_ghs>0 and free_ai_limit>=0 and coalesce(free_questions_limit, 0)>=0);
drop policy if exists "settings admin update" on public.app_settings;
create policy "settings admin update" on public.app_settings for update using(is_admin()) with check(is_admin() and price_ghs>0 and free_ai_limit>=0 and coalesce(free_questions_limit, 0)>=0);

create or replace function public.consume_free_ai() returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  lim int := 5;
  used int := 0;
  prem timestamptz;
begin
  if uid is null then raise exception 'Sign in first'; end if;
  select coalesce(free_ai_limit, 5) into lim from public.app_settings where id=1;
  lim := coalesce(lim, 5);
  if public.is_admin() then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'remaining', 9999, 'limit', lim);
  end if;
  select coalesce(premium_expires_at, premium_until), coalesce(ai_uses, 0) into prem, used from public.profiles where id=uid for update;
  used := coalesce(used, 0);
  if prem is not null and prem > now() then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'remaining', 9999, 'limit', lim);
  end if;
  if used >= lim then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'remaining', 0, 'limit', lim);
  end if;
  update public.profiles set ai_uses = used + 1 where id=uid;
  return jsonb_build_object('allowed', true, 'unlimited', false, 'remaining', greatest(lim - (used + 1), 0), 'limit', lim);
end $$;

create or replace function public.open_past_question(qid uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  lim int := 3;
  prem timestamptz;
  unlocked uuid[] := '{}';
  used_count int := 0;
  q_rec record;
  q_body text;
  q_preview text := '';
begin
  if uid is null then raise exception 'Sign in first'; end if;
  select coalesce(free_questions_limit, 3) into lim from public.app_settings where id=1;
  lim := greatest(coalesce(lim, 3), 0);

  select q.id, q.status, q.uploader, qc.content into q_rec
  from public.questions q
  left join public.question_content qc on qc.question_id = q.id
  where q.id = qid;

  if q_rec.id is null then
    return jsonb_build_object('allowed', false, 'not_found', true, 'limit', lim, 'remaining', 0, 'used', 0);
  end if;

  if q_rec.status <> 'approved' and not public.is_admin() and q_rec.uploader <> uid then
    return jsonb_build_object('allowed', false, 'limit', lim, 'remaining', 0, 'used', 0);
  end if;

  q_body := coalesce(q_rec.content, '');

  if public.is_admin() or q_rec.uploader = uid then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'content', q_body, 'remaining', 9999, 'limit', lim, 'used', 0);
  end if;

  insert into public.profiles(id) values(uid) on conflict (id) do nothing;
  select coalesce(premium_expires_at, premium_until), coalesce(free_question_ids, '{}') into prem, unlocked
  from public.profiles where id = uid for update;
  unlocked := coalesce(unlocked, '{}');
  used_count := coalesce(array_length(unlocked, 1), 0);

  if prem is not null and prem > now() then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'content', q_body, 'remaining', 9999, 'limit', lim, 'used', used_count);
  end if;

  if qid = any(unlocked) then
    return jsonb_build_object(
      'allowed', true,
      'unlimited', false,
      'already_unlocked', true,
      'content', q_body,
      'used', used_count,
      'remaining', greatest(lim - used_count, 0),
      'limit', lim,
      'free_question_ids', unlocked
    );
  end if;

  if used_count >= lim then
    if length(trim(q_body)) > 0 then
      if length(trim(q_body)) <= 220 then
        q_preview := left(trim(q_body), greatest(60, floor(length(trim(q_body)) * 0.4)::int));
      else
        q_preview := left(trim(q_body), 340);
      end if;
      if length(q_preview) < length(trim(q_body)) then
        q_preview := regexp_replace(q_preview, '\s+\S*$', '') || '...';
      end if;
    end if;
    return jsonb_build_object(
      'allowed', false,
      'unlimited', false,
      'is_preview', (length(q_preview) > 0),
      'preview', q_preview,
      'used', used_count,
      'remaining', 0,
      'limit', lim,
      'free_question_ids', unlocked
    );
  end if;

  unlocked := array_append(unlocked, qid);
  update public.profiles set free_question_ids = unlocked where id = uid;
  used_count := coalesce(array_length(unlocked, 1), 0);

  return jsonb_build_object(
    'allowed', true,
    'unlimited', false,
    'already_unlocked', false,
    'content', q_body,
    'used', used_count,
    'remaining', greatest(lim - used_count, 0),
    'limit', lim,
    'free_question_ids', unlocked
  );
end $$;
-- MAKE AN ADMIN (run in SQL editor with the user's id from Authentication > Users):
-- insert into admins(user_id) values('PASTE-USER-UUID') on conflict (user_id) do nothing;
