import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from '../../../scripts/load-ts-module.mjs'

const { SseParser, readSseStream } = loadTsModule('src/shared/utils/sse.ts')

test('parses events split across arbitrary chunk boundaries', () => {
  const parser = new SseParser()
  const text = 'data: {"type":"token","text":"Hel"}\n\ndata: {"type":"token","text":"lo"}\r\n\r\ndata: [DONE]\n\n'
  const events = []
  for (let i = 0; i < text.length; i += 7) events.push(...parser.feed(text.slice(i, i + 7)))
  assert.deepEqual(events.map((e) => e.text), ['Hel', 'lo'])
})

test('skips malformed payloads and comment lines', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.feed(': keepalive\n\ndata: {bad\n\ndata: {"ok":1}\n\n'), [{ ok: 1 }])
})

test('reads a stream body and flushes a trailing event without blank line', async () => {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"n":1}\n\nda'))
      controller.enqueue(enc.encode('ta: {"n":2}'))
      controller.close()
    },
  })
  const seen = []
  await readSseStream(body, (e) => seen.push(e.n))
  assert.deepEqual(seen, [1, 2])
})
