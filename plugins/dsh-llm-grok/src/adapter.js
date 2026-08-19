import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  CHAT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
  PROVIDER,
} from './constants.js'
import { ensureFreshSession, loadSession } from './oauth.js'
import { serializeRequest } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'

function effortLabel(value) {
  if (value === 'none' || value === 'off') return 'Off'
  if (value === 'low') return 'Low'
  if (value === 'medium') return 'Medium'
  if (value === 'high') return 'High'
  if (value === 'xhigh') return 'xHigh'
  return value
}

function observedBody(body, signal, onChunk = () => {}) {
  const reader = body.getReader()
  let released = false
  let cancelPromise
  let abortHandler

  const release = () => {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // The reader can already be released by the stream implementation.
    }
  }
  const cleanup = () => {
    if (abortHandler !== undefined) {
      signal.removeEventListener('abort', abortHandler)
      abortHandler = undefined
    }
  }
  const cancelReader = (reason) => {
    if (cancelPromise !== undefined) return cancelPromise
    cancelPromise = Promise.resolve().then(() => reader.cancel(reason)).finally(() => {
      cleanup()
      release()
    })
    return cancelPromise
  }

  const observed = new ReadableStream({
    start() {
      abortHandler = () => {
        void cancelReader(signal.reason).catch(() => {})
      }
      if (signal.aborted) {
        abortHandler()
      } else {
        signal.addEventListener('abort', abortHandler, { once: true })
      }
    },
    async pull(controller) {
      try {
        const result = await abortable(reader.read(), signal)
        if (result.done) {
          cleanup()
          release()
          controller.close()
          return
        }
        onChunk()
        controller.enqueue(result.value)
      } catch (error) {
        cleanup()
        release()
        controller.error(error)
      }
    },
    cancel(reason) {
      return cancelReader(reason)
    },
  })
  return observed
}

async function readBodyText(body, signal, onChunk = () => {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let released = false
  let cancelPromise
  let abortHandler

  const release = () => {
    if (released) return
    released = true
    try {
      reader.releaseLock()
    } catch {
      // The reader can already be released by the stream implementation.
    }
  }
  const cleanup = () => {
    if (abortHandler !== undefined) {
      signal.removeEventListener('abort', abortHandler)
      abortHandler = undefined
    }
  }
  const cancelReader = (reason) => {
    if (cancelPromise !== undefined) return cancelPromise
    cancelPromise = Promise.resolve().then(() => reader.cancel(reason)).finally(() => {
      cleanup()
      release()
    })
    return cancelPromise
  }

  abortHandler = () => {
    void cancelReader(signal.reason).catch(() => {})
  }
  if (signal.aborted) {
    abortHandler()
  } else {
    signal.addEventListener('abort', abortHandler, { once: true })
  }
  try {
    while (true) {
      const result = await abortable(reader.read(), signal)
      if (result.done) break
      onChunk()
      text += decoder.decode(result.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    cleanup()
    release()
  }
}

function abortable(promise, signal) {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then((value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
  })
}

export function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export async function resolveGrokAccessToken(runtime, signal) {
  const existing = await loadSession(runtime)
  const session = await ensureFreshSession(runtime, { signal })
  if (session === undefined) {
    if (existing !== undefined) {
      throw new LlmError(
        'llm-grok: session refresh failed; sign in again from Settings → Grok',
        'AUTH',
      )
    }
    throw new LlmError(
      'llm-grok: not signed in; open Settings → Grok and sign in with SuperGrok or X Premium+',
      'MISSING_CREDENTIAL',
    )
  }
  return session.accessToken
}

export class GrokAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: 'Grok' }
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  resolveModel(provider, model) {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    const efforts = (configured?.reasoningEfforts ?? []).map(value => ({
      id: ReasoningEffortId(value),
      name: effortLabel(value),
    }))
    return Promise.resolve({
      ...configured === undefined
        ? {
          provider,
          id: model,
          name: model,
          inputModalities: /** @type {readonly ['text']} */ (['text']),
        }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...efforts.length === 0
        ? {}
        : {
          reasoning: {
            efforts,
            defaultEffort: ReasoningEffortId(
              configured?.defaultReasoningEffort ?? efforts[0].id,
            ),
          },
        },
    })
  }

  async * stream(options) {
    const connection = this.config.options()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const credentialDeadline = deadline(
      upstream,
      connection.streamIdleTimeoutMs,
      'LLM_STREAM_IDLE_TIMEOUT',
    )
    const watchdog = idleWatchdog(
      credentialDeadline.signal,
      connection.streamIdleTimeoutMs,
      'LLM_STREAM_IDLE_TIMEOUT',
    )
    let iterator
    let exhausted = false
    try {
      const apiKey = await abortable(
        Promise.resolve().then(() => this.config.resolveApiKey(credentialDeadline.signal)),
        credentialDeadline.signal,
      )
      credentialDeadline[Symbol.dispose]()
      iterator = this.request(
        options,
        watchdog.signal,
        connection,
        apiKey,
        () => { watchdog.pulse() },
      )[Symbol.asyncIterator]()
      while (true) {
        const result = await watchdog.next(iterator)
        if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
          throw watchdog.signal.reason
        }
        if (result.done) {
          exhausted = true
          return
        }
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error('Grok request aborted by caller')
        }
        yield result.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(
          `Grok stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Grok request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      if (error && typeof error.code === 'string') {
        throw new LlmError(error.message, error.code, { cause: error })
      }
      throw new LlmError(`Grok API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort()
      watchdog[Symbol.dispose]()
      credentialDeadline[Symbol.dispose]()
      if (!exhausted && iterator?.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer signal already owns transport teardown.
        }
      }
    }
  }

  async * request(options, signal, connection, apiKey, onChunk = () => {}) {
    let body
    try {
      body = serializeRequest(options)
    } catch (error) {
      throw new LlmError(error.message, error.code ?? 'INVALID_REQUEST', { cause: error })
    }
    let response
    try {
      response = await abortable(fetch(`${connection.baseURL.replace(/\/+$/u, '')}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-grok-client-version': GROK_CLI_CLIENT_VERSION,
          'x-grok-client-identifier': GROK_CLI_CLIENT_IDENTIFIER,
          'x-dsh-plugin': 'dsh-llm-grok/0.1.0',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      }), signal)
    } catch (error) {
      if (signal.aborted) throw error
      throw new LlmError(`Grok API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `Grok API error (HTTP ${response.status})`
      try {
        const parsed = response.body
          ? JSON.parse(await readBodyText(response.body, signal, onChunk))
          : typeof response.json === 'function'
            ? await abortable(Promise.resolve().then(() => response.json()), signal)
            : undefined
        const detail = parsed?.error?.message ?? parsed?.message
        if (typeof detail === 'string' && detail.length > 0) message = detail
      } catch {
        // Keep the status-based message.
      }
      throw new LlmError(message, httpErrorCode(response.status), { status: response.status })
    }
    if (!response.body) {
      throw new LlmError('Grok API returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translate(parseSse(observedBody(response.body, signal, onChunk)))
  }
}

export function defaultConnectionOptions(retryPolicy) {
  return {
    baseURL: CHAT_BASE_URL,
    models: DEFAULT_MODELS,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy,
  }
}

/** @returns {import('@deepseek-ai/dsh-llm').LlmModelInfo} */
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: /** @type {readonly ['text']} */ (['text']),
  }
}
