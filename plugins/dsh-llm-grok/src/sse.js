export const DONE = '[DONE]'

/** @typedef {Error & { code: string }} CodedError */

/** @returns {CodedError} */
function coded(message, code) {
  const error = /** @type {CodedError} */ (new Error(message))
  error.code = code
  return error
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTerminalPayload(payload) {
  if (payload === DONE) return true
  try {
    const event = JSON.parse(payload)
    if (!isRecord(event)) return false
    if (
      event.type === 'error'
      || event.type === 'response.completed'
      || event.type === 'response.incomplete'
      || event.type === 'response.failed'
      || event.type === 'response.aborted'
      || event.type === 'response.cancelled'
      || event.type === 'response.canceled'
    ) {
      return true
    }
    return Array.isArray(event.choices)
      && event.choices.some(choice => isRecord(choice) && typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)
  } catch {
    return false
  }
}

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` last.
 * cli-chat-proxy (Responses API) closes after a response terminal event and
 * does not send OpenAI's `data: [DONE]` line.
 */
export async function* parseSse(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingCR = false
  let terminalSeen = false

  function append(text) {
    if (pendingCR) {
      buffer += '\n'
      pendingCR = false
      if (text.startsWith('\n')) text = text.slice(1)
    }
    if (text.endsWith('\r')) {
      pendingCR = true
      text = text.slice(0, -1)
    }
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }

  function drain() {
    const events = []
    let split
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const data = eventData(event)
      if (data !== undefined) events.push(data)
    }
    return events
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      append(decoder.decode(value, { stream: true }))
      for (const data of drain()) {
        terminalSeen ||= isTerminalPayload(data)
        yield data
        if (data === DONE) return
      }
    }
    append(decoder.decode())
    for (const data of drain()) {
      terminalSeen ||= isTerminalPayload(data)
      yield data
      if (data === DONE) return
    }
  } finally {
    reader.releaseLock()
  }
  if (terminalSeen) {
    yield DONE
    return
  }
  throw coded('SSE stream ended without a terminal event', 'STREAM_CLOSED')
}

function eventData(event) {
  const lines = event.split('\n')
  const data = []
  for (const line of lines) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return undefined
  return data.join('\n')
}
