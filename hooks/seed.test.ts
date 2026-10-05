import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parse, pathOf } from './register'

const body = (text: string | undefined) => (text ?? '').split('\n\n— seed')[0]

/** An in-memory disk standing in for the engine's file system. */
const disk = (on: On) => {
  const files = new Map<string, string>()
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) }) as never)
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text } as never
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  return files
}

/** A model that answers "draw 1", "draw 2", ... and counts how often it was asked. */
const model = (on: On) => {
  const count = { draws: 0 }
  on('model.complete', async () => ({ value: { isAnswered: true, text: `draw ${++count.draws}`, usage: {} } }) as never)
  return count
}

test('parse splits the seed from the question', () => {
  expect(parse('42 What is X?')).toEqual({ seed: '42', question: 'What is X?' })
  expect(parse('  abc   two words  ')).toEqual({ seed: 'abc', question: 'two words' })
  expect(parse('42')).toEqual(undefined)
  expect(parse('')).toEqual(undefined)
})

test('same seed and question replay the identical answer without asking the model again', async ($, on) => {
  disk(on)
  const count = model(on)
  const first = await $.command.run({ command: 'seed', args: '42 What is X?' })
  const second = await $.command.run({ command: 'seed', args: '42 What is X?' })
  expect(body(first.text)).toEqual('draw 1')
  expect(body(second.text)).toEqual('draw 1')
  expect(count.draws).toEqual(1)
  expect(first.text).toContain('first draw')
  expect(second.text).toContain('replayed')
})

test('a different seed, or a different question, draws a fresh answer', async ($, on) => {
  disk(on)
  model(on)
  const a = await $.command.run({ command: 'seed', args: '42 What is X?' })
  const b = await $.command.run({ command: 'seed', args: '43 What is X?' })
  const c = await $.command.run({ command: 'seed', args: '42 What is Y?' })
  expect([body(a.text), body(b.text), body(c.text)]).toEqual(['draw 1', 'draw 2', 'draw 3'])
})

test('the pinned file records seed, question, model, time and fingerprint', async ($, on) => {
  const files = disk(on)
  model(on)
  await $.command.run({ command: 'seed', args: '42 What is X?' })
  const path = await pathOf('42', 'What is X?')
  expect(path.startsWith('seeds/42-')).toEqual(true)
  expect([...files.keys()].map(k => k.endsWith(path))).toEqual([true])
  const pinned = JSON.parse([...files.values()][0] ?? '{}')
  expect([pinned.seed, pinned.question, pinned.answer, pinned.model]).toEqual(['42', 'What is X?', 'draw 1', 'haiku'])
  expect(String(pinned.sha256).length).toEqual(64)
  expect(Number.isNaN(Date.parse(pinned.drawnAt))).toEqual(false)
})

test('a pinned answer that was edited afterwards is refused', async ($, on) => {
  const files = disk(on)
  model(on)
  await $.command.run({ command: 'seed', args: '42 What is X?' })
  const [path, text] = [...files.entries()][0]!
  files.set(path, JSON.stringify({ ...JSON.parse(text), answer: 'a forged answer' }))
  const again = await $.command.run({ command: 'seed', args: '42 What is X?' })
  expect(again.text).toContain('was changed after it was drawn')
  expect((again.text ?? '').includes('a forged answer')).toEqual(false)
})

test('a failed model call pins nothing', async ($, on) => {
  const files = disk(on)
  on('model.complete', async () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, usage: {} } }) as never)
  const out = await $.command.run({ command: 'seed', args: '42 What is X?' })
  expect(out.text).toContain('nothing was pinned')
  expect(files.size).toEqual(0)
})

test('missing question shows how to use it', async $ => {
  const out = await $.command.run({ command: 'seed', args: '42' })
  expect(out.text).toContain('Usage: /seed')
})

test('several /seed lines pasted together are refused, and nothing is asked or pinned', async ($, on) => {
  const files = disk(on)
  const count = model(on)
  const out = await $.command.run({ command: 'seed', args: '42 Write a slogan.\n/seed 43 Write a slogan.' })
  expect(out.text).toContain('one /seed line at a time')
  expect([count.draws, files.size]).toEqual([0, 0])
})
