import type { Register } from 'claude-code'

// A seed for LLM answers, the way pandas has one for random numbers:
// the same seed and the same question always give the identical answer,
// a different seed gives a fresh one.
//
// How: the first time a (seed, question) pair is asked, the model's answer
// is drawn once and pinned in a small file under seeds/. Every later ask
// with that pair returns the pinned answer, checked against its fingerprint.
// Commit seeds/ and anyone with the project gets the same answers.

export const MODEL = 'haiku'
export const DIR = 'seeds'
const USAGE =
  'Usage: /seed <seed> <question>\n' +
  'Example: /seed 42 What does Straive do?\n' +
  'The same seed and question always give the identical answer. A new seed gives a fresh one.'

export type Pinned = {
  seed: string
  question: string
  model: string
  answer: string
  drawnAt: string
  sha256: string
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** "42 What is X?" -> { seed: "42", question: "What is X?" }; undefined when either part is missing. */
export function parse(args: string): { seed: string; question: string } | undefined {
  const match = /^\s*(\S+)\s+([\s\S]*\S)\s*$/.exec(args)
  return match ? { seed: match[1]!, question: match[2]! } : undefined
}

export async function pathOf(seed: string, question: string): Promise<string> {
  const key = await sha256(`${MODEL}\n${seed}\n${question}`)
  const safe = seed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `${DIR}/${safe}-${key.slice(0, 16)}.json`
}

const footer = (p: Pinned, how: string) =>
  `\n\n— seed ${p.seed} · ${how} · model ${p.model} · drawn ${p.drawnAt} · fingerprint ${p.sha256.slice(0, 12)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'seed',
      description: 'Ask with a seed: the same seed and question always give the identical answer',
    })
    return next(e)
  })

  on('command.run', { command: 'seed' }, async ($, e) => {
    const asked = parse(e.args)
    if (!asked) return { text: USAGE }
    const path = await pathOf(asked.seed, asked.question)

    if (await $.fs.exists(path)) {
      let pinned: Pinned
      try {
        pinned = JSON.parse(await $.fs.read(path)) as Pinned
      } catch {
        return { text: `The pinned answer in ${path} cannot be read. Delete the file to draw again.` }
      }
      if ((await sha256(pinned.answer)) !== pinned.sha256) {
        return {
          text: `The pinned answer in ${path} was changed after it was drawn (its fingerprint no longer matches), so it is not shown. Delete the file to draw again.`,
        }
      }
      return { text: pinned.answer + footer(pinned, 'replayed, identical to the first draw') }
    }

    const reply = await $.model.complete({ model: MODEL, prompt: asked.question, maxTokens: 2048 })
    if (!reply.isAnswered) {
      return { text: `The model gave no answer (${reply.reason}), so nothing was pinned to seed ${asked.seed}.` }
    }
    const pinned: Pinned = {
      seed: asked.seed,
      question: asked.question,
      model: MODEL,
      answer: reply.text,
      drawnAt: new Date().toISOString(),
      sha256: await sha256(reply.text),
    }
    await $.fs.write(path, JSON.stringify(pinned, null, 2) + '\n')
    return { text: pinned.answer + footer(pinned, `first draw, pinned in ${path}`) }
  })
}
