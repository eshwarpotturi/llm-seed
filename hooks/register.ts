import type { Engine, Register } from 'claude-code'

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
  'Shared with a team: /seed pricing/42 What does Straive do?\n' +
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

// Team seeds: `/seed pricing/42 <question>` pins the answer in a shared store,
// so every teammate with the team's token gets the same words.
//
// The store is a Supabase project set up with supabase/setup.sql. The mod never
// touches its tables: it calls two functions, seed_get and seed_put, and each
// checks the team token. If two people draw at once, the store keeps the first
// answer and hands it to both.

const TEAM_SEED = /^([a-z0-9][a-z0-9-]{0,39})\/(\S+)$/
const CONFIG_FILE = 'seed.config.json'
const TOKEN_FILE = '.seed-token'
const USER_FILE = '.seed-user'

type Row = { seed: string; model: string; answer: string; sha256: string; drawn_by: string; drawn_at: string }
type Ask = { team: string; seed: string; question: string; model: string }
type Sha = (text: string) => Promise<string>

const SETUP = `Team seeds need a shared store. Put its address and public key in ${CONFIG_FILE} in this project, as {"url": "...", "key": "..."}. The README has the steps.`
const NO_TOKEN = 'Team seeds need your team token. Set it as SEED_TEAM_TOKEN before starting Claude Code, or save it in a file named .seed-token in this project. Ask whoever created the team for it.'

const teamFooter = (team: string, row: Row, how: string) =>
  `\n\n— seed ${team}/${row.seed} · ${how} · drawn by ${row.drawn_by} on ${row.drawn_at} · model ${row.model} · fingerprint ${row.sha256.slice(0, 12)}`

async function config($: Engine): Promise<{ url: string; key: string } | undefined> {
  const url = await $.env.get('SEED_STORE_URL')
  const key = await $.env.get('SEED_STORE_KEY')
  if (url && key) return { url: url.replace(/\/+$/, ''), key }
  try {
    if (!(await $.fs.exists(CONFIG_FILE))) return undefined
    const file = JSON.parse(await $.fs.read(CONFIG_FILE)) as { url?: unknown; key?: unknown }
    if (typeof file.url !== 'string' || typeof file.key !== 'string' || !file.url || !file.key) return undefined
    return { url: file.url.replace(/\/+$/, ''), key: file.key }
  } catch {
    return undefined
  }
}

/** Calls one store function. Resolves the JSON it returned, or a short reason it failed. */
async function call($: Engine, store: { url: string; key: string }, name: string, args: Record<string, string>, secret: string): Promise<{ data: unknown } | { problem: string }> {
  // Real team tokens are 64 characters. Very short values are not scrubbed, or ordinary words would be.
  const clean = (text: string) => (secret.length >= 16 ? text.split(secret).join('***') : text).replace(/\s+/g, ' ').slice(0, 160)
  try {
    const r = await $.http.fetch(`${store.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: store.key, Authorization: `Bearer ${store.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    let data: unknown
    try {
      data = JSON.parse(r.text)
    } catch {
      data = undefined
    }
    if (r.ok) return { data: data ?? null }
    const message = (data as { message?: unknown } | undefined)?.message
    return { problem: clean(typeof message === 'string' ? message : `the store answered with status ${r.status}`) }
  } catch (e) {
    const code = /E[A-Z]{4,}/.exec(e instanceof Error ? e.message : '')?.[0]
    return { problem: `The team store could not be reached${code ? ` (${code})` : ''}` }
  }
}

const isRow = (v: unknown): v is Row =>
  typeof v === 'object' && v !== null && ['seed', 'model', 'answer', 'sha256', 'drawn_by', 'drawn_at'].every(k => typeof (v as Record<string, unknown>)[k] === 'string')

async function teamSeed($: Engine, ask: Ask, sha256: Sha): Promise<string> {
  const store = await config($)
  if (!store) return SETUP
  let token = await $.env.get('SEED_TEAM_TOKEN')
  if (!token && (await $.fs.exists(TOKEN_FILE))) token = (await $.fs.read(TOKEN_FILE)).trim()
  if (!token) return NO_TOKEN
  let who = await $.env.get('SEED_USER')
  if (!who && (await $.fs.exists(USER_FILE))) who = (await $.fs.read(USER_FILE)).trim()
  who = who || (await $.env.get('USER')) || 'unknown'
  const key = await sha256(`${ask.model}\n${ask.seed}\n${ask.question}`)
  const base = { p_team: ask.team, p_token: token, p_key: key }
  const refused = (what: string) => `${what} Nothing was pinned to seed ${ask.team}/${ask.seed}.`
  const checked = async (row: Row, how: string) =>
    (await sha256(row.answer)) === row.sha256
      ? row.answer + teamFooter(ask.team, row, how)
      : `The answer stored for seed ${ask.team}/${ask.seed} does not match its fingerprint, so it is not shown. Tell whoever runs the team store.`

  const got = await call($, store, 'seed_get', { ...base, p_who: who }, token)
  if ('problem' in got) return refused(`${got.problem}.`)
  if (isRow(got.data)) return checked(got.data, 'replayed from the team store')

  const reply = await $.model.complete({ model: ask.model, prompt: ask.question, maxTokens: 2048 })
  if (!reply.isAnswered) return refused(`The model gave no answer (${reply.reason}).`)
  const mine = await sha256(reply.text)
  const put = await call($, store, 'seed_put', { ...base, p_seed: ask.seed, p_question: ask.question, p_model: ask.model, p_answer: reply.text, p_sha256: mine, p_who: who }, token)
  if ('problem' in put) return refused(`${put.problem}. The model answered, but the answer could not be saved, so it is not shown.`)
  if (!isRow(put.data)) return refused('The team store returned something unexpected.')
  return checked(put.data, put.data.sha256 === mine ? 'first draw, pinned in the team store' : 'a teammate pinned this seed first, so this is their answer')
}

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
    if (/\n\s*\/seed\b/.test(asked.question)) {
      return { text: 'Send one /seed line at a time. Several were pasted together, so nothing was asked or pinned.' }
    }
    const team = TEAM_SEED.exec(asked.seed)
    if (team) {
      return { text: await teamSeed($, { team: team[1]!, seed: team[2]!, question: asked.question, model: MODEL }, sha256) }
    }
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
