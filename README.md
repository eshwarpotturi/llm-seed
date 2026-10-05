# Seed: a seed for LLM answers

A small add-on (a "mod") for Claude Code that makes an LLM answer repeatable.

**Project page:** https://eshwarpotturi.github.io/llm-seed/

```
/seed 42 Write a one-line slogan for an AI analytics team.
```

- The same seed and the same question always give the **identical** answer.
- A different seed gives a fresh answer.
- Anyone with this project and the same seed gets the same answer you did.

## Contents

- [What is this?](#what-is-this)
- [Why does it exist?](#why-does-it-exist)
- [What it looks like](#what-it-looks-like)
- [How to run it](#how-to-run-it)
- [How it works](#how-it-works)
- [Questions and answers](#questions-and-answers)
- [Limits](#limits)
- [For developers](#for-developers)

## What is this?

In pandas or numpy, you set a seed so that "random" results come out the same
every time. That lets someone else rerun your work and get your numbers.

LLMs have no such thing in everyday use. Ask the same question twice and you get
two different answers. This mod adds a `/seed` command that gives LLM answers the
same property: pick a seed, and the answer for that seed and question is fixed.

## Why does it exist?

Three everyday problems:

| Problem | What people do today | What a seed gives you |
|---|---|---|
| "The AI told me X" cannot be checked by anyone else | Share a screenshot or a chat link | A seed and a question that a colleague can rerun and get the same words |
| A demo gives a different answer on stage than in rehearsal | Hope, or paste the answer into a slide | The rehearsed answer, replayed exactly |
| A result in a report cannot be reproduced later | Nothing | The answer is stored with the project, with the time it was drawn |

A chat link shows that the model said something once. It can be deleted by its
owner, it does not travel with a project, and many company accounts block
sharing. A seed is a short thing you can put in a document: "seed 42, this
question".

## What it looks like

These are real outputs from the first run of this mod (5 Oct 2026).

Asked once with seed 42:

```
/seed 42 Write a one-line slogan for an AI analytics team.

"Turning data into decisions, one insight at a time."

— seed 42 · first draw, pinned in seeds/42-85cb96a7d3c2a4c7.json · model haiku · drawn 2026-10-05T16:53:28.855Z · fingerprint f3b787d2e728
```

Asked again with seed 42, the answer is the same, word for word:

```
"Turning data into decisions, one insight at a time."

— seed 42 · replayed, identical to the first draw · model haiku · drawn 2026-10-05T16:53:28.855Z · fingerprint f3b787d2e728
```

Asked with seed 43, the answer is different:

```
"Turning data into decisions, at the speed of intelligence."

— seed 43 · first draw, pinned in seeds/43-1aa14557d49e2404.json · model haiku · drawn 2026-10-05T16:53:40.967Z · fingerprint 52a83f5df3f9
```

The last line of every reply tells you:

| Part | Meaning |
|---|---|
| `seed 42` | The seed you used |
| `first draw` or `replayed` | Whether the model was asked just now, or a saved answer was returned |
| `model haiku` | Which model gave the answer |
| `drawn ...` | When the model first gave this answer (UTC) |
| `fingerprint ...` | The first 12 characters of a SHA-256 hash of the answer text. Same fingerprint means the same text |

## How to run it

You need a Claude Code version that supports mods.

1. Download this repository (the green "Code" button, then "Download ZIP", and
   unzip it), or clone it:

   ```bash
   git clone https://github.com/eshwarpotturi/llm-seed
   ```

2. Start Claude Code with the mod loaded, giving the path to the folder:

   ```bash
   claude --plugin-dir /path/to/llm-seed
   ```

3. Type one line at a time and press Enter after each:

   ```
   /seed 42 Write a one-line slogan for an AI analytics team.
   /seed 42 Write a one-line slogan for an AI analytics team.
   /seed 43 Write a one-line slogan for an AI analytics team.
   ```

   The first two answers match. The third is different.

## How it works

The mod does not change how the model picks its words. Chat tools give no control
over that. It works one level up:

1. You type `/seed <seed> <question>`.
2. The mod builds a key from three things: the model name, the seed and the exact
   question.
3. It looks for a saved answer under that key in the `seeds/` folder of the
   project you are working in.
4. **No saved answer:** the model is asked once. The answer is saved, and shown
   to you marked `first draw`.
5. **Saved answer found:** its fingerprint is checked, and the saved answer is
   shown marked `replayed`. The model is not asked.

Each saved answer is one small, readable file:

```json
{
  "seed": "42",
  "question": "Write a one-line slogan for an AI analytics team.",
  "model": "haiku",
  "answer": "\"Turning data into decisions, one insight at a time.\"",
  "drawnAt": "2026-10-05T16:53:28.855Z",
  "sha256": "f3b787d2e728..."
}
```

What happens in each case:

| Situation | Result |
|---|---|
| New seed and question | The model is asked once and the answer is saved |
| Same seed and question again | The saved answer is returned after its fingerprint is checked |
| Same seed, different question | A new draw. One changed word makes it a different question |
| Same question, different seed | A new draw |
| Saved answer edited by hand | The fingerprint no longer matches, and the mod refuses to show it |
| The model call fails | Nothing is saved, and the mod says so |
| Several `/seed` lines pasted at once | Refused: "Send one /seed line at a time" |

## Questions and answers

**Does this make the model deterministic?**
No. The model is as random as before. The seed makes the *result* repeatable by
fixing the first answer drawn for that seed. If you ask the same question without
`/seed`, you still get a different answer each time.

**So is it a cache?**
Yes, with three differences that matter. The seed is chosen by you, so you can
ask for a new draw on purpose by changing it. The saved answers are plain files
that travel with the project, so other people get the same results. And each one
carries the time it was drawn and a fingerprint.

**Why not use a real seed?**
Where a model's developer interface offers a seed setting, it is described as
best effort: the same seed usually gives the same output, not always, and it can
change when the provider updates the model. Chat tools do not expose it at all.
Saving the answer is the only way to get an exact match every time.

**What does the seed number mean?**
Nothing by itself. It is a label. `42`, `7` and `demo-day` all work. Any text
without spaces is a valid seed.

**Is seed 42 the same answer for everyone in the world?**
Only for people who share the `seeds/` folder. A seed with no saved answer draws
a new one. To share your answers, commit the `seeds/` folder to git with your
project.

**Does a seed only work in the chat window where I first used it?**
No. The saved answer is a file in the project folder, not part of the chat. Any
chat, on any computer, that is opened in a copy of that folder with the mod
loaded gets the same answer. A chat opened in a different folder does not see it
and draws a new one.

**How do I share a result with a colleague?**
Commit and push the `seeds/` folder. Tell them the seed and the question. They
download the project, load the mod and run the same line.

This repository already carries two saved answers, so anyone can check it:

```bash
git clone https://github.com/eshwarpotturi/llm-seed
cd llm-seed
claude --plugin-dir .
```

```
/seed 42 Write a one-line slogan for an AI analytics team.
```

The reply is `"Turning data into decisions, one insight at a time."`, marked
`replayed`, with fingerprint `f3b787d2e728`. Seed 43 with the same question
replays `"Turning data into decisions, at the speed of intelligence."`.

**How is this better than sharing a chat link?**

| | Chat link | Seed |
|---|---|---|
| Shows what the model said | Yes | Yes |
| The other person can rerun it and get the same words | No | Yes |
| Lives with the project files | No | Yes |
| The owner can delete it | Yes | Only by deleting the file, which git history still shows |
| Records model and time | Depends on the tool | Always |

**Can someone fake an answer?**
The fingerprint catches a saved answer that was edited afterwards: the mod
refuses to show it. It does not stop someone who rewrites both the answer and the
fingerprint. For that, rely on git history, which shows who changed the file and
when. This is evidence, not cryptographic proof.

**I changed one word in the question and got a new answer. Why?**
The question is part of the key, so it must match exactly, including punctuation
and capital letters.

**How do I get a new answer for the same seed and question?**
Delete that answer's file in `seeds/`, or use a different seed.

**Does a replay cost anything?**
No. A replay reads a file. Only a first draw calls the model.

**Which model answers?**
Claude Haiku, a small and fast model, so it may not know niche facts. To use
another model, change the `MODEL` line near the top of `hooks/register.ts`. The
model name is part of the key, so answers from different models never mix.

**Does it change my normal Claude Code chats?**
No. It only acts when you type `/seed`. Everything else behaves as before.

**Where are the answers kept?**
In a `seeds/` folder inside whichever project folder Claude Code is open in. The
file name starts with the seed, for example `seeds/42-85cb96a7d3c2a4c7.json`.

**Is my question private?**
The question and answer are saved as plain text in `seeds/`. If you push that
folder to a public repository, everyone can read them. Do not use `/seed` for
confidential questions in a project you publish.

**Why did it say "Send one /seed line at a time"?**
Several `/seed` lines were pasted together. They would have been sent as one long
question, so the mod stops and asks for one line at a time.

**Does the question remember earlier messages in the chat?**
No. Each `/seed` question is sent to the model alone, with no chat history. That
is what makes it rerunnable by someone else.

**Does something like this already exist?**
In parts. Developer tools cache model calls, and some model interfaces have a
best-effort seed setting. This puts the idea where the work happens, as one
command, with answers that are shared through the project.

## Limits

- **The model is still random.** Only the result for a seed is fixed.
- **A saved answer is one draw.** It shows what the model said once, not what it
  usually says. Try a few seeds to see the spread.
- **Exact match only.** A reworded question is a new question.
- **Text in, text out.** No files, images, web search or chat history.
- **Answers are capped** at about 1,500 words.
- **Mods are a new Claude Code feature**, so this needs a version that supports
  them.

## The experiment behind the project page

The [project page](https://eshwarpotturi.github.io/llm-seed/) shows results from
120 real runs on 5 October 2026 with Claude Haiku:

| Question | Asks | Different answers |
|---|---|---|
| Write a one-line slogan for an AI analytics team | 30, each with its own seed | 22 |
| What is the capital of France? | 30, each with its own seed | 2 wordings of the same fact |
| Pick a random number between 1 and 100 | 30, each with its own seed | 1 (it was 42 every time) |
| The slogan question again, with seed 1 | 30 | 1, with one fingerprint |

Two answers count as the same only if the text matches exactly. Thirty asks is a
small sample, so the counts would shift on another day or another model. Every
answer is in `data/experiment.json`.

The page is built from that file: `python3 site/build.py` fills
`site/template.html` and writes `index.html`.

## For developers

| File | What it is |
|---|---|
| `.claude-plugin/plugin.json` | The mod's name and description |
| `hooks/hooks.json` | Points Claude Code at the code |
| `hooks/register.ts` | The whole mod, about 90 lines |
| `hooks/seed.test.ts` | 8 tests |

```bash
claude plugin validate .
claude plugin test .
```

The tests use a stand-in model and an in-memory file system, so they call no real
model and write no files.
