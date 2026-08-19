import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DONE, parseSse } from '../src/sse.js'

function sseStream(chunks) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collect(stream) {
  const payloads = []
  for await (const payload of parseSse(stream)) payloads.push(payload)
  return payloads
}

test('parseSse yields [DONE] after a normal close without a sentinel', async () => {
  const payloads = await collect(sseStream([
    'data: {"type":"response.output_text.delta","delta":"pong"}\n\n',
    'data: {"type":"response.completed"}\n\n',
  ]))
  assert.deepEqual(payloads, [
    '{"type":"response.output_text.delta","delta":"pong"}',
    '{"type":"response.completed"}',
    DONE,
  ])
})

test('parseSse does not duplicate [DONE] when the server sends it', async () => {
  const payloads = await collect(sseStream(['data: [DONE]\n\n']))
  assert.deepEqual(payloads, [DONE])
})

test('parseSse reports STREAM_CLOSED when EOF has no terminal event', async () => {
  await assert.rejects(
    () => collect(sseStream(['data: {"type":"response.output_text.delta","delta":"pong"}\n\n'])),
    error => error.code === 'STREAM_CLOSED',
  )
})

test('parseSse keeps CRLF line endings intact when split across chunks', async () => {
  const payloads = await collect(sseStream([
    'data: first\r',
    '\ndata: second\r',
    '\n\r',
    '\ndata: [DONE]\r\n\r\n',
  ]))
  assert.deepEqual(payloads, ['first\nsecond', DONE])
})

test('parseSse treats a top-level error as a terminal event at EOF', async () => {
  const error = 'data: {"type":"error","code":"rate_limit","message":"slow down"}\n\n'
  assert.deepEqual(await collect(sseStream([error])), [
    '{"type":"error","code":"rate_limit","message":"slow down"}',
    DONE,
  ])
})

test('parseSse treats response.aborted as a terminal event at EOF', async () => {
  const aborted = 'data: {"type":"response.aborted","error":{"code":"cancelled","message":"stop"}}\n\n'
  assert.deepEqual(await collect(sseStream([aborted])), [
    '{"type":"response.aborted","error":{"code":"cancelled","message":"stop"}}',
    DONE,
  ])
})

test('parseSse treats response.incomplete without response details as terminal at EOF', async () => {
  const incomplete = 'data: {"type":"response.incomplete","incomplete_details":{"reason":"max_output_tokens"}}\n\n'
  assert.deepEqual(await collect(sseStream([incomplete])), [
    '{"type":"response.incomplete","incomplete_details":{"reason":"max_output_tokens"}}',
    DONE,
  ])
})

test('parseSse preserves UTF-8 characters split across byte chunks', async () => {
  const encoder = new TextEncoder()
  const source = encoder.encode('data: {"text":"🙂"}\n\ndata: [DONE]\n\n')
  const emojiStart = encoder.encode('data: {"text":"').length
  const payloads = await collect(sseStream([
    source.slice(0, emojiStart + 1),
    source.slice(emojiStart + 1),
  ]))
  assert.deepEqual(payloads, ['{"text":"🙂"}', DONE])
})

test('parseSse ignores keep-alive comment events', async () => {
  const payloads = await collect(sseStream([
    ': keep-alive\n\n',
    'data: {"ok":true}\n\n',
    'data: [DONE]\n\n',
  ]))
  assert.deepEqual(payloads, ['{"ok":true}', DONE])
})

test('parseSse joins multiple data lines into one payload', async () => {
  const payloads = await collect(sseStream([
    'data: first\n',
    'data: second\n\n',
    'data: [DONE]\n\n',
  ]))
  assert.deepEqual(payloads, ['first\nsecond', DONE])
})

test('parseSse releases its reader lock after normal EOF', async () => {
  const stream = sseStream(['data: {"type":"response.completed"}\n\n'])
  await collect(stream)
  assert.equal(stream.locked, false)
})
