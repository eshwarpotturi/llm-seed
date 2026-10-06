import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { sha256 } from './register'

const body = (text: string | undefined) => (text ?? '').split('\n\n— seed')[0]
const CONFIG = JSON.stringify({ url: 'https://store.example', key: 'public-key' })

/** Files in memory. Paths are matched by their ending, since the engine may make them absolute. */
const disk = (on: On, files: Record<string, string> = { 'seed.config.json': CONFIG }) => {
  const find = (path: string) => Object.keys(files).find(name => path.endsWith(name))
  on('fs.exists', async (_$, e) => ({ value: find(e.path) !== undefined }) as never)
  on('fs.read', async (_$, e) => {
    const name = find(e.path)
    if (name === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: files[name] } as never
  })
  on('fs.write', async (_$, e) => {
    files[e.path] = e.text
    return { value: undefined } as never
  })
  return files
}

const model = (on: On, prefix = 'draw') => {
  const count = { draws: 0 }
  on('model.complete', async () => ({ value: { isAnswered: true, text: `${prefix} ${++count.draws}`, usage: {} } }) as never)
  return count
}

type Row = { team: string; key: string; seed: string; question: string; model: string; answer: string; sha256: string; drawn_by: string; drawn_at: string }

/** A stand-in for the Supabase store with the same rules as supabase/setup.sql. */
const store = (on: On, opts: { token?: string; down?: boolean; beforePut?: (rows: Map<string, Row>, args: Record<string, string>) => void } = {}) => {
  const rows = new Map<string, Row>()
  const calls: { url: string; headers: Record<string, string>; args: Record<string, string> }[] = []
  const reply = (status: number, data: unknown) => ({ value: { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(data) } }) as never
  on('http.fetch', async (_$, e) => {
    const { url, init } = e as unknown as { url: string; init?: { headers?: Record<string, string>; body?: string } }
    const args = JSON.parse(init?.body ?? '{}') as Record<string, string>
    calls.push({ url, headers: init?.headers ?? {}, args })
    if (opts.down) throw new Error('connect ETIMEDOUT')
    if (args.p_team !== 'pricing' || args.p_token !== (opts.token ?? 'team-token')) return reply(403, { code: '28000', message: 'unknown team or wrong token' })
    const id = `${args.p_team}/${args.p_key}`
    if (url.endsWith('/rest/v1/rpc/seed_get')) return reply(200, rows.get(id) ?? null)
    if (url.endsWith('/rest/v1/rpc/seed_put')) {
      opts.beforePut?.(rows, args)
      if (!rows.has(id)) rows.set(id, { team: args.p_team, key: args.p_key, seed: args.p_seed, question: args.p_question, model: args.p_model, answer: args.p_answer, sha256: args.p_sha256, drawn_by: args.p_who, drawn_at: '2026-10-06T09:00:00Z' })
      return reply(200, rows.get(id))
    }
    return reply(404, { message: 'not found' })
  })
  return { rows, calls }
}

const ASK = 'pricing/42 What is X?'

test('one teammate draws, the other replays the same answer without asking the model', async ($, on) => {
  disk(on); const s = store(on); const count = model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'team-token', SEED_USER: 'alice' })
  const first = await $.command.run({ command: 'seed', args: ASK })
  const second = await $.command.run({ command: 'seed', args: ASK })
  expect([body(first.text), body(second.text), count.draws, s.rows.size]).toEqual(['draw 1', 'draw 1', 1, 1])
  expect(first.text).toContain('first draw, pinned in the team store')
  expect(second.text).toContain('replayed from the team store')
  expect(second.text).toContain('drawn by alice')
})

test('the store is called with the public key, the team token and who is asking', async ($, on) => {
  disk(on); const s = store(on); model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'team-token', SEED_USER: 'alice' })
  await $.command.run({ command: 'seed', args: ASK })
  const get = s.calls[0]!
  expect(get.url).toEqual('https://store.example/rest/v1/rpc/seed_get')
  expect([get.headers.apikey, get.headers.Authorization]).toEqual(['public-key', 'Bearer public-key'])
  expect([get.args.p_team, get.args.p_token, get.args.p_who, get.args.p_key?.length]).toEqual(['pricing', 'team-token', 'alice', 64])
  const put = s.calls[1]!
  expect([put.args.p_seed, put.args.p_question, put.args.p_model, put.args.p_answer]).toEqual(['42', 'What is X?', 'haiku', 'draw 1'])
  expect(put.args.p_sha256).toEqual(await sha256('draw 1'))
})

test('if a teammate pins first, their answer is shown, not mine', async ($, on) => {
  disk(on); model(on, 'mine')
  const theirs = 'their answer'; const theirHash = await sha256(theirs)
  store(on, { beforePut: (rows, a) => rows.set(`${a.p_team}/${a.p_key}`, { team: 'pricing', key: a.p_key!, seed: '42', question: 'What is X?', model: 'haiku', answer: theirs, sha256: theirHash, drawn_by: 'bob', drawn_at: '2026-10-06T08:59:59Z' }) })
  mock.env(on, { SEED_TEAM_TOKEN: 'team-token', SEED_USER: 'alice' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect(body(out.text)).toEqual('their answer')
  expect(out.text).toContain('a teammate pinned this seed first')
  expect(out.text).toContain('drawn by bob')
})

test('an unreachable store pins nothing and does not show an unpinned answer', async ($, on) => {
  disk(on); store(on, { down: true }); const count = model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'team-token' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect(out.text).toContain('team store could not be reached')
  expect([count.draws, (out.text ?? '').includes('draw 1')]).toEqual([0, false])
})

test('a wrong token is reported and nothing is drawn', async ($, on) => {
  disk(on); store(on); const count = model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'wrong' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect(out.text).toContain('unknown team or wrong token')
  expect(count.draws).toEqual(0)
})

test('a missing token or missing config says what to set up', async ($, on) => {
  disk(on); store(on); model(on); mock.env(on, {})
  expect((await $.command.run({ command: 'seed', args: ASK })).text).toContain('SEED_TEAM_TOKEN')
})

test('a missing store config says what to set up', async ($, on) => {
  disk(on, {}); store(on); model(on); mock.env(on, { SEED_TEAM_TOKEN: 'team-token' })
  expect((await $.command.run({ command: 'seed', args: ASK })).text).toContain('seed.config.json')
})

test('a stored answer whose fingerprint does not match is refused', async ($, on) => {
  disk(on); const s = store(on); model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'team-token' })
  await $.command.run({ command: 'seed', args: ASK })
  const [id, row] = [...s.rows.entries()][0]!
  s.rows.set(id, { ...row, answer: 'a forged answer' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect(out.text).toContain('fingerprint')
  expect((out.text ?? '').includes('a forged answer')).toEqual(false)
})

test('the team token never appears in what the user sees', async ($, on) => {
  disk(on); store(on, { token: 'other' }); model(on)
  mock.env(on, { SEED_TEAM_TOKEN: 'SECRET-TOKEN-VALUE' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect((out.text ?? '').includes('SECRET-TOKEN-VALUE')).toEqual(false)
})

test('a plain seed still stays local and never calls the store', async ($, on) => {
  const files = disk(on); const s = store(on); model(on); mock.env(on, { SEED_TEAM_TOKEN: 'team-token' })
  const out = await $.command.run({ command: 'seed', args: '42 What is X?' })
  expect(out.text).toContain('pinned in seeds/')
  expect([s.calls.length, Object.keys(files).some(f => f.includes('seeds/42-'))]).toEqual([0, true])
})

test('the token can come from a .seed-token file when the variable is not set', async ($, on) => {
  disk(on, { 'seed.config.json': CONFIG, '.seed-token': 'team-token\n' }); const s = store(on); model(on); mock.env(on, { SEED_USER: 'alice' })
  const out = await $.command.run({ command: 'seed', args: ASK })
  expect(out.text).toContain('first draw, pinned in the team store')
  expect(s.calls[0]!.args.p_token).toEqual('team-token')
})
