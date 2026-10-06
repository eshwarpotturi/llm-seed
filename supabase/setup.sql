-- Seed team store. Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to run again: nothing is dropped and existing answers are kept.
--
-- What it creates:
--   seed_teams    one row per team, holding only a hash of the team's token
--   seed_answers  one row per (team, model, seed, question): the pinned answer
--   seed_events   who drew or replayed what, and when
-- Nobody can read or write these tables directly. Everything goes through the
-- four functions at the bottom, and each one checks the team token first.

create table if not exists public.seed_teams (
  team        text primary key check (team ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  token_hash  text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.seed_answers (
  team      text not null references public.seed_teams (team),
  key       text not null check (key ~ '^[0-9a-f]{64}$'),   -- sha256 of model, seed and question
  seed      text not null,
  question  text not null,
  model     text not null,
  answer    text not null check (length(answer) <= 200000),
  sha256    text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  drawn_by  text not null,
  drawn_at  timestamptz not null default now(),
  primary key (team, key)                                    -- this is what makes the first draw win
);

create table if not exists public.seed_events (
  id      bigint generated always as identity primary key,
  team    text not null,
  key     text not null,
  action  text not null check (action in ('draw', 'replay', 'lost-race')),
  who     text not null,
  at      timestamptz not null default now()
);

alter table public.seed_teams   enable row level security;
alter table public.seed_answers enable row level security;
alter table public.seed_events  enable row level security;
revoke all on public.seed_teams, public.seed_answers, public.seed_events from public, anon, authenticated;

-- Internal: is this the right token for this team?
create or replace function public.seed_check(p_team text, p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from seed_teams
    where team = p_team and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  ) then
    raise exception 'unknown team or wrong token' using errcode = '28000';
  end if;
end $$;

-- Read a pinned answer. Returns null when there is none yet.
create or replace function public.seed_get(p_team text, p_token text, p_key text, p_who text)
returns json language plpgsql security definer set search_path = public as $$
declare hit seed_answers;
begin
  perform seed_check(p_team, p_token);
  select * into hit from seed_answers where team = p_team and key = p_key;
  if not found then return null; end if;
  insert into seed_events (team, key, action, who) values (p_team, p_key, 'replay', left(p_who, 80));
  return row_to_json(hit);
end $$;

-- Pin an answer. If a teammate pinned one first, theirs is kept and returned.
create or replace function public.seed_put(
  p_team text, p_token text, p_key text, p_seed text, p_question text,
  p_model text, p_answer text, p_sha256 text, p_who text
) returns json language plpgsql security definer set search_path = public as $$
declare stored seed_answers; inserted int;
begin
  perform seed_check(p_team, p_token);
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

-- Run by you in the SQL editor, never by the mod: creates a team and shows its token ONCE.
-- Example:  select seed_new_team('pricing');
create or replace function public.seed_new_team(p_team text) returns text
language plpgsql security definer set search_path = public as $$
declare token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into seed_teams (team, token_hash) values (p_team, encode(sha256(convert_to(token, 'UTF8')), 'hex'));
  return token;
end $$;

revoke all on function public.seed_check(text, text) from public, anon, authenticated;
revoke all on function public.seed_new_team(text) from public, anon, authenticated;
revoke all on function public.seed_get(text, text, text, text) from public;
revoke all on function public.seed_put(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.seed_get(text, text, text, text) to anon, authenticated;
grant execute on function public.seed_put(text, text, text, text, text, text, text, text, text) to anon, authenticated;
