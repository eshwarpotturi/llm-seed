# Seed: a seed for LLM answers

A Claude Code mod. In pandas or numpy, a seed makes random results repeatable.
This gives LLM answers the same property.

```
/seed 42 What does Straive do?
```

- The same seed and the same question always give the **identical** answer.
- A different seed gives a fresh answer.
- Anyone with this project and the same seed gets the same answer you did.

So a result can be shared as a seed that others rerun, not only as a chat link.

## Try it

1. Clone this repository.
2. Start Claude Code with the mod loaded:

   ```bash
   claude --plugin-dir /path/to/llm-seed
   ```

3. In Claude Code:

   ```
   /seed 42 What does Straive do?      first draw
   /seed 42 What does Straive do?      identical, word for word
   /seed 43 What does Straive do?      a fresh answer
   ```

Each reply ends with a line like:

```
— seed 42 · replayed, identical to the first draw · model haiku · drawn 2026-10-05T16:43:54Z · fingerprint 64653be18ceb
```

## How it works

An LLM picks its words with some randomness, and chat tools give no control over
it. So the mod does not try to make the model itself deterministic.

The first time a seed and question are used, the model answers once and the mod
pins that answer to the seed, in a small file under `seeds/`. Every later use of
the same seed and question returns the pinned answer without asking the model
again.

| | What happens |
|---|---|
| New seed and question | The model is asked once. The answer is saved with the seed, the question, the model, the time and a SHA-256 fingerprint of the text |
| Same seed and question again | The saved answer is returned, after its fingerprint is checked |
| Saved file edited by hand | The fingerprint no longer matches, and the mod refuses to show it |
| Model call fails | Nothing is saved |

Commit the `seeds/` folder and the answers travel with the project.

## Limits

- **The model is still random.** The seed makes the result repeatable. It does
  not make the model repeat itself.
- **A pinned answer is one draw.** It shows what the model said once, not what it
  would usually say.
- **The question must match exactly.** A changed word is a different question and
  gets a new draw.
- **Mods are a new Claude Code feature**, so this needs a Claude Code build that
  supports them.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The 7 tests use a stand-in model and an in-memory file system, so they call no
real model.
