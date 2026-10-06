# Setting up the team store (about 10 minutes, once)

Team seeds (`/seed pricing/42 ...`) are kept in a Supabase project so that
teammates get the same answer. One person sets this up. Everyone else only needs
the team token.

## 1. Create the project

1. Sign in at https://supabase.com and create a new project. Any name works, for
   example `llm-seed-store`. Pick the region closest to you.
2. Wait until the project says it is ready.

## 2. Create the tables and rules

1. Open **SQL Editor** in the left menu.
2. Paste the whole of [`setup.sql`](setup.sql) and press **Run**.

It is safe to run again later. Nothing is deleted.

## 3. Create a team

In the SQL Editor, run this with your team's name (small letters, digits and
hyphens only):

```sql
select seed_new_team('demo');
```

The result is the **team token**, a 64-character code. It is shown once and only
a scrambled copy is stored, so copy it now. Give it to teammates privately. Do not
put it in a repository, a chat or a slide.

If a token is lost, or the wrong person has seen it, issue a new one. The old one
stops working at once and the team's saved answers are kept:

```sql
select seed_reset_token('demo');
```

## 4. Point the mod at the store

1. In Supabase, open **Project Settings**, then **API**. Copy the **Project URL**
   and the **publishable** key (older projects call it the **anon** key).
   Do not copy the secret or service-role key.
2. In the project folder where you use Claude Code, create `seed.config.json`:

   ```json
   { "url": "https://YOUR-PROJECT.supabase.co", "key": "YOUR-PUBLISHABLE-KEY" }
   ```

   This file is safe to share with the team. That key only lets someone call the
   two store functions, and both refuse anyone without a team token.

## 5. Give the mod your token and name

Either set two variables before starting Claude Code:

```bash
export SEED_TEAM_TOKEN='the-64-character-token'
export SEED_USER='your-name'
```

or save the token alone in a file named `.seed-token` in the project folder, and
your name in a file named `.seed-user`. This repository's `.gitignore` already
keeps both files out of git.

## 6. Try it

```
/seed demo/42 Write a one-line slogan for an AI analytics team.
```

The reply ends with `first draw, pinned in the team store · drawn by your-name`.
A teammate who runs the same line sees the same answer, marked
`replayed from the team store · drawn by your-name`.

In Supabase, **Table Editor** shows the answer in `seed_answers` and a line per
ask in `seed_events`.

## What the store guarantees

| Rule | How |
|---|---|
| The first draw wins | The table allows one row per team, model, seed and question. A second write is ignored and the first answer is handed back |
| Only the team can read or write | Every call checks the team token. The tables cannot be read directly |
| The token is not stored | Only its SHA-256 hash is |
| A changed answer is caught | The store refuses an answer whose fingerprint does not match, and the mod checks again on every replay |
| There is a record | `seed_events` logs each draw, replay and lost race with who and when |

## Limits

- **The data is outside your company.** Use it for demos and harmless questions.
  For real work, run `setup.sql` on a Postgres database your company controls.
  The mod only needs a different `url` and `key`.
- **Anyone with the team token can read that team's answers** if they know the
  seed and the exact question. There is one token per team, not one per person,
  so the name in `drawn by` is whatever that person set and is not verified.
- **Free Supabase projects pause when unused.** Open the project the day before a
  demo.
- **`setup.sql` is tested on Postgres 16** with `sh supabase/test.sh` (19 checks),
  and has been run on one real Supabase project.
