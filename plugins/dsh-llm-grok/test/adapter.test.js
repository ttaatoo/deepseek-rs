import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GrokAdapter } from '../src/adapter.js'

function adapterOf(overrides = {}) {
  const { resolveApiKey = async () => 'test-token', ...connectionOverrides } = overrides
  const connection = {
    baseURL: 'https://grok.example.test/api',
    models: [],
    defaultContextWindow: 128_000,
    maxTokens: 1_000,
    streamIdleTimeoutMs: 100,
    retryPolicy: {},
    ...connectionOverrides,
  }
  return new GrokAdapter({
    options: () => connection,
    resolveApiKey,
  })
}

function requestOptions(overrides = {}) {
  return {
    model: 'grok-4.6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  }
}

test('model fetch rejects redirects explicitly', async () => {
  const originalFetch = globalThis.fetch
  let init
  globalThis.fetch = async (_input, requestInit) => {
    init = requestInit
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    for await (const _chunk of adapterOf().stream(requestOptions())) {
      // Drain the stream so request() reaches fetch and the response body.
    }
    assert.equal(init.redirect, 'error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream idle timeout aborts an outstanding body read with a stable error', async () => {
  const originalFetch = globalThis.fetch
  const caller = new AbortController()
  let stopped = false
  globalThis.fetch = async (_input, requestInit) => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"a"}\n\n'))
        requestInit.signal.addEventListener('abort', () => {
          stopped = true
          controller.error(requestInit.signal.reason)
        }, { once: true })
      },
    })
    return new Response(body, { status: 200 })
  }
  const stream = adapterOf({ streamIdleTimeoutMs: 20 }).stream({
    ...requestOptions(),
    signal: caller.signal,
  })
  const drain = (async () => {
    for await (const _chunk of stream) {
      // Keep reading until the provider goes idle.
    }
  })().catch(error => error)
  const safetyAbort = setTimeout(() => caller.abort(), 100)
  try {
    const error = await drain
    assert.equal(error.code, 'TIMEOUT')
    assert.match(error.message, /idle timeout after 20ms/)
    assert.equal(stopped, true)
  } finally {
    clearTimeout(safetyAbort)
    globalThis.fetch = originalFetch
  }
})

test('stream timeout does not hang when fetch ignores abort', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => new Promise(() => {})
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf({ streamIdleTimeoutMs: 20 }).stream(requestOptions())) {
        // Wait for the provider timeout while fetch is pending.
      }
    })().catch(error => error)
    const error = await drain
    assert.equal(error.code, 'TIMEOUT')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('caller abort cancels credential resolution before the request starts', async () => {
  const caller = new AbortController()
  let credentialSignal
  let releaseCredentials
  const credentials = new Promise(resolve => { releaseCredentials = resolve })
  const stream = adapterOf({
    resolveApiKey: signal => {
      credentialSignal = signal
      return credentials
    },
  }).stream({
    ...requestOptions(),
    signal: caller.signal,
  })
  const next = stream.next()
  await new Promise(resolve => setImmediate(resolve))
  caller.abort()
  try {
    const error = await Promise.race([
      next.then(() => new Error('credential abort resolved'), error => error),
      new Promise((_, reject) => setTimeout(() => reject(new Error('credential abort hung')), 100)),
    ])
    assert.equal(error.code, 'ABORTED')
    assert.equal(credentialSignal.aborted, true)
  } finally {
    releaseCredentials?.('late-token')
    await stream.return?.()
  }
})

test('stream idle timeout covers credential resolution before the request starts', async () => {
  let credentialSignal
  const stream = adapterOf({
    streamIdleTimeoutMs: 20,
    resolveApiKey: signal => {
      credentialSignal = signal
      return new Promise(() => {})
    },
  }).stream(requestOptions())
  const next = stream.next()
  try {
    const error = await Promise.race([
      next.then(() => new Error('credential timeout resolved'), error => error),
      new Promise((_, reject) => setTimeout(() => reject(new Error('credential timeout hung')), 100)),
    ])
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(credentialSignal.aborted, true)
  } finally {
    await stream.return?.()
  }
})

test('stream idle timeout resets when the provider sends chunks without events', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\n\n'))
        setTimeout(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 10)
        setTimeout(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 20)
        setTimeout(() => {
          controller.enqueue(encoder.encode([
            'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
            'data: {"type":"response.completed"}\n\n',
          ].join('')))
          controller.close()
        }, 35)
      },
    })
    return new Response(body, { status: 200 })
  }
  try {
    const chunks = []
    for await (const chunk of adapterOf({ streamIdleTimeoutMs: 25 }).stream(requestOptions())) {
      chunks.push(chunk)
    }
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('caller abort returns ABORTED and releases the response reader', async () => {
  const originalFetch = globalThis.fetch
  const caller = new AbortController()
  let cancelled = false
  let released = false
  let finishRead
  const doneChunk = new TextEncoder().encode('data: [DONE]\n\n')
  globalThis.fetch = async (_input, requestInit) => {
    const reader = {
      read() {
        return new Promise(resolve => {
          finishRead = () => resolve({ done: false, value: doneChunk })
        })
      },
      cancel() {
        cancelled = true
        finishRead?.()
        return Promise.resolve()
      },
      releaseLock() {
        released = true
      },
    }
    return { ok: true, status: 200, body: { getReader: () => reader } }
  }
  const stream = adapterOf({ streamIdleTimeoutMs: 100 }).stream({
    ...requestOptions(),
    signal: caller.signal,
  })
  const drain = (async () => {
    for await (const _chunk of stream) {
      // Wait for the caller cancellation while the body reader is pending.
    }
  })().catch(error => error)
  setTimeout(() => caller.abort(), 10)
  try {
    const error = await drain
    assert.equal(error.code, 'ABORTED')
    assert.equal(cancelled, true)
    assert.equal(released, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a successful response without a body returns EMPTY_RESPONSE', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, body: undefined })
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf().stream(requestOptions())) {
        // Consume the stream to surface the response validation error.
      }
    })()
    await assert.rejects(drain, error => {
      assert.equal(error.code, 'EMPTY_RESPONSE')
      assert.equal(error.message, 'Grok API returned no response body')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a response reader error stays TRANSPORT and releases its reader', async () => {
  const originalFetch = globalThis.fetch
  const readerError = new Error('body read failed')
  let released = false
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => { throw readerError },
          cancel: async () => {},
          releaseLock() {
            released = true
          },
        }
      },
    },
  })
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf().stream(requestOptions())) {
        // Consume the stream to surface the reader failure.
      }
    })()
    await assert.rejects(drain, error => {
      assert.equal(error.code, 'TRANSPORT')
      assert.equal(error.cause, readerError)
      assert.equal(released, true)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a non-success response keeps its HTTP error when the body is malformed', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError('invalid json') },
  })
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf().stream(requestOptions())) {
        // Consume the stream to surface the HTTP failure.
      }
    })()
    await assert.rejects(drain, error => {
      assert.equal(error.code, 'SERVER')
      assert.equal(error.message, 'Grok API error (HTTP 502)')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a malformed non-success body releases its response reader', async () => {
  const originalFetch = globalThis.fetch
  let body
  globalThis.fetch = async () => {
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{not-json'))
        controller.close()
      },
    })
    return new Response(body, { status: 502 })
  }
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf().stream(requestOptions())) {
        // Consume the stream to surface the HTTP failure.
      }
    })()
    await assert.rejects(drain, error => {
      assert.equal(error.code, 'SERVER')
      assert.equal(error.message, 'Grok API error (HTTP 502)')
      assert.equal(body.locked, false)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('caller abort during an HTTP error body returns ABORTED and releases its reader', async () => {
  const originalFetch = globalThis.fetch
  const caller = new AbortController()
  let cancelled = false
  let released = false
  let finishRead
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    body: {
      getReader() {
        return {
          read() {
            return new Promise(resolve => {
              finishRead = () => resolve({ done: true, value: undefined })
            })
          },
          cancel() {
            cancelled = true
            finishRead?.()
            return Promise.resolve()
          },
          releaseLock() {
            released = true
          },
        }
      },
    },
  })
  const stream = adapterOf({ streamIdleTimeoutMs: 100 }).stream({
    ...requestOptions(),
    signal: caller.signal,
  })
  const drain = (async () => {
    for await (const _chunk of stream) {
      // Wait for cancellation while the error body is pending.
    }
  })().catch(error => error)
  setTimeout(() => caller.abort(), 10)
  try {
    const error = await drain
    assert.equal(error.code, 'ABORTED')
    assert.equal(cancelled, true)
    assert.equal(released, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream timeout during an HTTP error body returns TIMEOUT and releases its reader', async () => {
  const originalFetch = globalThis.fetch
  let cancelled = false
  let released = false
  let finishRead
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    body: {
      getReader() {
        return {
          read() {
            return new Promise(resolve => {
              finishRead = () => resolve({ done: true, value: undefined })
            })
          },
          cancel() {
            cancelled = true
            finishRead?.()
            return Promise.resolve()
          },
          releaseLock() {
            released = true
          },
        }
      },
    },
  })
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf({ streamIdleTimeoutMs: 20 }).stream(requestOptions())) {
        // Wait for the provider timeout while the error body is pending.
      }
    })().catch(error => error)
    const error = await drain
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(cancelled, true)
    assert.equal(released, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream timeout does not hang on an HTTP error parser that ignores abort', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: () => new Promise(() => {}),
  })
  try {
    const drain = (async () => {
      for await (const _chunk of adapterOf({ streamIdleTimeoutMs: 20 }).stream(requestOptions())) {
        // Wait for the provider timeout while its error parser is pending.
      }
    })().catch(error => error)
    const error = await drain
    assert.equal(error.code, 'TIMEOUT')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream completes cleanly when the caller aborts after the final finish', async () => {
  const originalFetch = globalThis.fetch
  const caller = new AbortController()
  globalThis.fetch = async () => new Response([
    'data: {"type":"response.output_text.delta","delta":"done"}\n\n',
    'data: {"type":"response.completed"}\n\n',
  ].join(''), { status: 200 })
  const iterator = adapterOf().stream({
    ...requestOptions(),
    signal: caller.signal,
  })[Symbol.asyncIterator]()
  try {
    let sawFinish = false
    while (!sawFinish) {
      const result = await iterator.next()
      assert.equal(result.done, false)
      sawFinish = result.value.type === 'finish'
    }
    caller.abort()
    assert.deepEqual(await iterator.next(), { done: true, value: undefined })
  } finally {
    globalThis.fetch = originalFetch
    await iterator.return?.()
  }
})
