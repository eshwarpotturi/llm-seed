-- Seed web app: members and the service's functions.
-- Run this once in the Supabase SQL editor, AFTER setup.sql. Safe to run again.
--
-- The web app never touches the database. It calls the "seed" Edge Function, which
-- checks who is signed in and then calls the functions below with the project's
-- service key. People are members of teams by email. Saved answers live in the same
-- seed_answers table the /seed command uses, so both see the same notebook.

create table if not exists public.seed_members (
  team      text not null references public.seed_teams (team),
  email     text not null check (email = lower(email) and position('@' in email) > 1),
  role      text not null default 'member' check (role in ('admin', 'member')),
  added_by  text not null,
  added_at  timestamptz not null default now(),
  primary key (team, email)
);
alter table public.seed_members enable row level security;
revoke all on public.seed_members from public, anon, authenticated;

-- Run by you in the SQL editor: creates a team (if it does not exist) and makes one person its admin.
-- Example:  select seed_app_new_team('demo', 'you@example.com');
create or replace function public.seed_app_new_team(p_team text, p_admin_email text) returns text
language plpgsql security definer set search_path = public as $$
begin
  insert into seed_teams (team, token_hash)
  values (p_team, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'))
  on conflict (team) do nothing;
  insert into seed_members (team, email, role, added_by) values (p_team, lower(trim(p_admin_email)), 'admin', 'setup')
  on conflict (team, email) do update set role = 'admin';
  return 'team ' || p_team || ' is ready, admin ' || lower(trim(p_admin_email));
end $$;

-- Internal: the caller's role in the team, or an error if they are not in it.
create or replace function public.seed_svc_role(p_team text, p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  select role into r from seed_members where team = p_team and email = lower(trim(p_email));
  if r is null then raise exception 'you are not a member of this team' using errcode = '28000'; end if;
  return r;
end $$;

create or replace function public.seed_svc_teams(p_email text) returns json
language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('team', team, 'role', role) order by team), '[]'::json)
  from seed_members where email = lower(trim(p_email));
$$;

create or replace function public.seed_svc_get(p_team text, p_email text, p_key text) returns json
language plpgsql security definer set search_path = public as $$
declare hit seed_answers;
begin
  perform seed_svc_role(p_team, p_email);
  select * into hit from seed_answers where team = p_team and key = p_key;
  if not found then return null; end if;
  insert into seed_events (team, key, action, who) values (p_team, p_key, 'replay', lower(trim(p_email)));
  return row_to_json(hit);
end $$;

create or replace function public.seed_svc_put(
  p_team text, p_email text, p_key text, p_seed text, p_question text,
  p_model text, p_answer text, p_sha256 text
) returns json language plpgsql security definer set search_path = public as $$
declare stored seed_answers; inserted int;
begin
  perform seed_svc_role(p_team, p_email);
  if p_sha256 <> encode(sha256(convert_to(p_answer, 'UTF8')), 'hex') then
    raise exception 'fingerprint does not match the answer' using errcode = '22000';
  end if;
  insert into seed_answers (team, key, seed, question, model, answer, sha256, drawn_by)
  values (p_team, p_key, p_seed, p_question, p_model, p_answer, p_sha256, lower(trim(p_email)))
  on conflict (team, key) do nothing;
  get diagnostics inserted = row_count;
  insert into seed_events (team, key, action, who)
  values (p_team, p_key, case when inserted = 1 then 'draw' else 'lost-race' end, lower(trim(p_email)));
  select * into stored from seed_answers where team = p_team and key = p_key;
  return row_to_json(stored);
end $$;

create or replace function public.seed_svc_list(p_team text, p_email text, p_limit int default 50) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform seed_svc_role(p_team, p_email);
  return (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select seed, question, model, answer, sha256, drawn_by, drawn_at
    from seed_answers where team = p_team order by drawn_at desc limit least(greatest(p_limit, 1), 200)) t);
end $$;

create or replace function public.seed_svc_members(p_team text, p_email text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform seed_svc_role(p_team, p_email);
  return (select coalesce(json_agg(json_build_object('email', email, 'role', role) order by role, email), '[]'::json)
          from seed_members where team = p_team);
end $$;

create or replace function public.seed_svc_add_member(p_team text, p_email text, p_new_email text) returns json
language plpgsql security definer set search_path = public as $$
declare e text := lower(trim(p_new_email));
begin
  if seed_svc_role(p_team, p_email) <> 'admin' then
    raise exception 'only a team admin can add people' using errcode = '28000';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that does not look like an email address' using errcode = '22000'; end if;
  insert into seed_members (team, email, role, added_by) values (p_team, e, 'member', lower(trim(p_email)))
  on conflict (team, email) do nothing;
  return seed_svc_members(p_team, p_email);
end $$;

-- ---------------------------------------------------------------------------
-- Open teams: for demos. Anyone with the app's link can ask and replay in an open
-- team without signing in. Names are typed by the visitor and are not verified.
-- Run by you in the SQL editor. Creates the team if it does not exist yet.
--   select seed_app_open('demo', true);    -- open it
--   select seed_app_open('demo', false);   -- close it again; saved answers are kept
alter table public.seed_teams add column if not exists is_open boolean not null default false;

create or replace function public.seed_app_open(p_team text, p_open boolean) returns text
language plpgsql security definer set search_path = public as $$
begin
  insert into seed_teams (team, token_hash, is_open)
  values (p_team, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), p_open)
  on conflict (team) do update set is_open = p_open;
  return 'team ' || p_team || case when p_open then ' is open to anyone with the link' else ' is closed: sign-in required' end;
end $$;

create or replace function public.seed_open_check(p_team text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from seed_teams where team = p_team and is_open) then
    raise exception 'this team is not open, sign in to use it' using errcode = '28000';
  end if;
end $$;

create or replace function public.seed_open_teams() returns json
language sql security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('team', team, 'role', 'guest') order by team), '[]'::json)
  from seed_teams where is_open;
$$;

create or replace function public.seed_open_get(p_team text, p_key text, p_who text) returns json
language plpgsql security definer set search_path = public as $$
declare hit seed_answers;
begin
  perform seed_open_check(p_team);
  select * into hit from seed_answers where team = p_team and key = p_key;
  if not found then return null; end if;
  insert into seed_events (team, key, action, who) values (p_team, p_key, 'replay', left(p_who, 80));
  return row_to_json(hit);
end $$;

create or replace function public.seed_open_put(
  p_team text, p_key text, p_seed text, p_question text, p_model text, p_answer text, p_sha256 text, p_who text
) returns json language plpgsql security definer set search_path = public as $$
declare stored seed_answers; inserted int;
begin
  perform seed_open_check(p_team);
  if p_sha256 <> encode(sha256(convert_to(p_answer, 'UTF8')), 'hex') then
    raise exception 'fingerprint does not match the answer' using errcode = '22000';
  end if;
  insert into seed_answers (team, key, seed, question, model, answer, sha256, drawn_by)
  values (p_team, p_key, p_seed, p_question, p_model, p_answer, p_sha256, left(p_who, 80))
  on conflict (team, key) do nothing;
  get diagnostics inserted = row_count;
  insert into seed_events (team, key, action, who)
  values (p_team, p_key, case when inserted = 1 then 'draw' else 'lost-race' end, left(p_who, 80));
  select * into stored from seed_answers where team = p_team and key = p_key;
  return row_to_json(stored);
end $$;

create or replace function public.seed_open_list(p_team text, p_limit int default 50) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform seed_open_check(p_team);
  return (select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
    select seed, question, model, answer, sha256, drawn_by, drawn_at
    from seed_answers where team = p_team order by drawn_at desc limit least(greatest(p_limit, 1), 200)) t);
end $$;

-- Only the service key may call the service functions. The public key and signed-in users cannot.
do $$
declare f text;
begin
  foreach f in array array[
    'seed_app_new_team(text, text)', 'seed_svc_role(text, text)', 'seed_svc_teams(text)',
    'seed_svc_get(text, text, text)', 'seed_svc_put(text, text, text, text, text, text, text, text)',
    'seed_svc_list(text, text, int)', 'seed_svc_members(text, text)', 'seed_svc_add_member(text, text, text)',
    'seed_app_open(text, boolean)', 'seed_open_check(text)', 'seed_open_teams()', 'seed_open_get(text, text, text)',
    'seed_open_put(text, text, text, text, text, text, text, text)', 'seed_open_list(text, int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if f like 'seed_svc_%' or f like 'seed_open_%' then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;
