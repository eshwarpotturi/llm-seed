# Setting up the web app (about 15 minutes, once)

The web app is the version for people who do not use a command line. They open a
link, sign in with their email, and ask. It uses the same Supabase project and the
same saved answers as the `/seed` command.

Do [the store setup](README.md) first (run `setup.sql`).

## 1. Add the members table and the service's functions

Open **SQL Editor**, paste the whole of [`app.sql`](app.sql), and press **Run**.

## 2. Create a team with yourself as admin

In the SQL Editor, with your own email:

```sql
select seed_app_new_team('demo', 'you@example.com');
```

Use the email you will sign in with. As admin you can add teammates from inside
the app.

## 3. Deploy the service

1. Open **Edge Functions** in the left menu and choose **Deploy a new function**,
   then **Via Editor**.
2. Name it exactly `seed`.
3. Replace the sample code with the whole of
   [`functions/seed/index.ts`](functions/seed/index.ts) and press **Deploy**.

## 4. Give the service a model key

The service needs a key to a model. A free one works.

**Free: a Google Gemini key**

1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. Press **Create API key** and copy it.
3. In Supabase, open **Edge Functions**, then **Secrets**, and add:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | the key you copied |

**Or paid: an Anthropic key.** Add it as `ANTHROPIC_API_KEY` instead. If both are
set, the Anthropic key is used.

The key stays inside Supabase. The web page never sees it.

Answers from the two model families are kept apart: the model family is part of
each seed's key. So a seed saved with Gemini is not replayed by the `/seed`
command, which uses Claude, and the other way round.

## 5. Tell Supabase where the app lives

Open **Authentication**, then **URL Configuration**:

- **Site URL:** `https://eshwarpotturi.github.io/llm-seed/app/`
- **Redirect URLs:** add the same address.

Without this, the sign-in link in the email opens the wrong page.

## 6. Use it

Open https://eshwarpotturi.github.io/llm-seed/app/, enter your email, and open the
link that arrives. Choose your team, type a seed and a question, and press Ask.

## If something does not work

| What you see | Likely cause |
|---|---|
| "The seed service could not be reached" | The function is not deployed, or is not named `seed` |
| A 401 "Invalid JWT" from the function | In the function's settings, turn off "Verify JWT". The function checks sign-in itself |
| "the service has no model key yet" | Step 4 was skipped, or the secret has a different name |
| "the model did not answer (status 429)" | The free key has hit its limit for now. Wait a minute and ask again |
| "you are not a member of this team" | Your sign-in email is not the one added in step 2 |
| The sign-in email never arrives | The free plan sends only a few emails an hour. Wait and try again, and check spam |

## How it is put together

| Piece | What it does | In a company |
|---|---|---|
| The web page (`app/index.html`) | The screen people use. Holds no secrets | An internal web app |
| Sign-in | Supabase emails a one-time link | Company single sign-on |
| The service (`functions/seed/index.ts`) | Checks who is signed in, asks the database whether they are in the team, returns the saved answer or asks the model once and saves it | An internal service |
| The database (`setup.sql`, `app.sql`) | Teams, members, answers and a log of every ask. Only the service can call it | The company's own Postgres |
| The model | Called by the service with a key the browser never sees | The company's approved AI gateway |

## Limits

- **The data is outside your company** while it runs on a personal Supabase project.
  Use harmless questions.
- **Anyone can request a sign-in link**, but a person who is not in a team sees
  nothing and cannot ask.
- **The model key is billed to whoever owns it.** Every first draw by any member
  uses it. Replays cost nothing.
- **Tested so far:** 35 database checks on Postgres 16, 16 tests of the service
  with stand-ins for Supabase and the model, and the page's screens with a
  stand-in service. See the main README for what has run on the live project.
