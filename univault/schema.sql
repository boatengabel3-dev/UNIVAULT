-- UniVault schema (fresh project). If you ran the old schema, drop those tables first.
create table questions(id uuid default gen_random_uuid() primary key,department text not null,course_code text not null,course_title text,description text,year int not null,semester int,uploader uuid references auth.users,status text default 'pending',created_at timestamptz default now());
create table question_content(question_id uuid primary key references questions on delete cascade,content text,file_url text);
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
create function submit_question(d text,c text,t text,y int,s int,body text,descr text default null) returns void language plpgsql security definer set search_path = public as $$
declare qid uuid; begin if auth.uid() is null then raise exception 'Sign in first'; end if;
if length(coalesce(body,''))<50 then raise exception 'Question text is too short'; end if;
insert into public.questions(department,course_code,course_title,description,year,semester,uploader) values(d,upper(c),t,descr,y,s,auth.uid()) returning id into qid;
insert into public.question_content(question_id,content) values(qid,body); end $$;
create function admin_publish_question(d text,c text,t text,y int,s int,body text,descr text default null) returns uuid language plpgsql security definer set search_path = public as $$
declare qid uuid; begin if not public.is_admin() then raise exception 'forbidden'; end if;
if length(coalesce(body,''))<20 then raise exception 'Question text is too short'; end if;
insert into public.questions(department,course_code,course_title,description,year,semester,uploader,status) values(d,upper(c),t,descr,y,s,auth.uid(),'approved') returning id into qid;
insert into public.question_content(question_id,content) values(qid,body); return qid; end $$;
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

