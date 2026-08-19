import { DONE } from './sse.js'

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

function mapUsage(usage) {
  if (!isRecord(usage)) return undefined
  const input = usage.input_tokens ?? usage.prompt_tokens
  const output = usage.output_tokens ?? usage.completion_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const cacheRead = usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: input - (typeof cacheRead === 'number' ? cacheRead : 0),
    outputTokens: output,
    ...typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {},
    ...typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {},
  }
}

function providerFailure(source, fallbackMessage, fallbackCode) {
  const nestedError = isRecord(source?.error)
    ? source.error
    : isRecord(source?.response?.error) ? source.response.error : undefined
  const details = nestedError ?? source
  const message = typeof details?.message === 'string' && details.message.length > 0
    ? details.message
    : fallbackMessage
  const code = typeof details?.code === 'string' && details.code.length > 0
    ? details.code
    : nestedError !== undefined && typeof details?.type === 'string' && details.type.length > 0
      ? details.type
      : fallbackCode
  return { message, code }
}

function mapIncomplete(event) {
  const details = isRecord(event.incomplete_details)
    ? event.incomplete_details
    : isRecord(event.response?.incomplete_details) ? event.response.incomplete_details : {}
  const reason = typeof details.reason === 'string' && details.reason.length > 0
    ? details.reason
    : undefined
  if (reason === 'max_output_tokens' || reason === 'max_tokens' || reason === 'length' || reason === 'token_limit') {
    return { kind: 'max-tokens' }
  }
  if (reason === 'cancelled' || reason === 'canceled' || reason === 'aborted' || reason === 'abort') {
    return {
      kind: 'aborted',
      failure: providerFailure(event, `model incomplete: ${reason}`, reason.toUpperCase()),
    }
  }
  return {
    kind: 'error',
    failure: providerFailure(
      event,
      `model incomplete: ${reason ?? 'unknown'}`,
      reason ?? 'INCOMPLETE',
    ),
  }
}

function isAbortedMarker(value) {
  if (typeof value !== 'string') return false
  const marker = value.toLowerCase()
  return marker === 'aborted' || marker === 'abort' || marker === 'cancelled' || marker === 'canceled'
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield harness StreamChunks.
 */
export async function* translate(payloads) {
  let nextIndex = 0
  const order = []
  let text
  let reasoning
  const chatTools = new Map()
  const responseToolsByItemId = new Map()
  const responseToolsByOutputIndex = new Map()
  const toolBlocks = new Set()
  let lastResponseTool
  let pendingFinish
  let pendingUsage
  let terminalSeen = false

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '', id: '', name: '', started: false }
    order.push(block)
    return block
  }

  function ensureText() {
    if (text === undefined) text = open('text')
    return text
  }

  function ensureReasoning() {
    if (reasoning === undefined) reasoning = open('reasoning')
    return reasoning
  }

  function ensureTool(index, id, name) {
    let block = chatTools.get(index)
    if (block === undefined) {
      block = open('tool-call')
      chatTools.set(index, block)
      toolBlocks.add(block)
    }
    if (id) block.id = id
    if (name) block.name = name
    return block
  }

  function ensureResponseTool(itemId, outputIndex, id, name) {
    let block
    if (itemId !== undefined) block = responseToolsByItemId.get(itemId)
    if (block === undefined && outputIndex !== undefined) block = responseToolsByOutputIndex.get(outputIndex)
    if (block === undefined && itemId === undefined && outputIndex === undefined) block = lastResponseTool
    if (block === undefined) {
      block = open('tool-call')
      toolBlocks.add(block)
    }
    lastResponseTool = block
    if (itemId !== undefined) responseToolsByItemId.set(itemId, block)
    if (outputIndex !== undefined) responseToolsByOutputIndex.set(outputIndex, block)
    if (id) block.id = id
    if (name) block.name = name
    return block
  }

  function startTool(block, emitted) {
    if (block.started) return
    block.started = true
    emitted.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
  }

  function applyChatDelta(choice) {
    const delta = choice.delta
    if (!isRecord(delta)) return []
    const emitted = []
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      const block = ensureReasoning()
      if (!block.started) {
        block.started = true
        emitted.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
      }
      block.text += delta.reasoning_content
      emitted.push({ type: 'reasoning-delta', index: block.index, text: delta.reasoning_content })
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const block = ensureText()
      if (!block.started) {
        block.started = true
        emitted.push({ type: 'block-start', index: block.index, blockType: 'text' })
      }
      block.text += delta.content
      emitted.push({ type: 'text-delta', index: block.index, text: delta.content })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) continue
        const index = typeof call.index === 'number' ? call.index : 0
        const fn = isRecord(call.function) ? call.function : {}
        const block = ensureTool(index, typeof call.id === 'string' ? call.id : '', typeof fn.name === 'string' ? fn.name : '')
        const args = typeof fn.arguments === 'string' ? fn.arguments : ''
        startTool(block, emitted)
        if (args.length > 0) {
          block.text += args
          emitted.push({
            type: 'tool-call-delta',
            index: block.index,
            id: block.id,
            name: block.name,
            argumentsDelta: args,
          })
        }
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      pendingFinish = mapFinish(choice.finish_reason)
      terminalSeen = true
    }
    return emitted
  }

  function applyResponsesEvent(event) {
    const emitted = []
    const type = event.type
    if ((type === 'response.output_text.delta' || type === 'response.text.delta') && typeof event.delta === 'string' && event.delta.length > 0) {
      const block = ensureText()
      if (!block.started) {
        block.started = true
        emitted.push({ type: 'block-start', index: block.index, blockType: 'text' })
      }
      block.text += event.delta
      emitted.push({ type: 'text-delta', index: block.index, text: event.delta })
    } else if (
      (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta')
      && typeof event.delta === 'string'
      && event.delta.length > 0
    ) {
      const block = ensureReasoning()
      if (!block.started) {
        block.started = true
        emitted.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
      }
      block.text += event.delta
      emitted.push({ type: 'reasoning-delta', index: block.index, text: event.delta })
    } else if (type === 'response.output_item.added' && isRecord(event.item) && event.item.type === 'function_call') {
      const itemId = typeof event.item.id === 'string'
        ? event.item.id
        : typeof event.item.call_id === 'string' ? event.item.call_id : undefined
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined
      const block = ensureResponseTool(itemId, outputIndex, event.item.call_id ?? '', event.item.name ?? '')
      if (typeof event.item.call_id === 'string') responseToolsByItemId.set(event.item.call_id, block)
      const initialArguments = typeof event.item.arguments === 'string' ? event.item.arguments : ''
      startTool(block, emitted)
      if (block.text.length === 0 && initialArguments.length > 0) {
        block.text = initialArguments
        emitted.push({
          type: 'tool-call-delta',
          index: block.index,
          id: block.id,
          name: block.name,
          argumentsDelta: block.text,
        })
      }
    } else if (type === 'response.output_item.done' && isRecord(event.item) && event.item.type === 'function_call') {
      const itemId = typeof event.item.id === 'string'
        ? event.item.id
        : typeof event.item.call_id === 'string' ? event.item.call_id : undefined
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined
      const block = ensureResponseTool(itemId, outputIndex, event.item.call_id ?? '', event.item.name ?? '')
      if (typeof event.item.call_id === 'string') responseToolsByItemId.set(event.item.call_id, block)
      startTool(block, emitted)
      if (typeof event.item.arguments === 'string') block.text = event.item.arguments
    } else if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : undefined
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined
      const block = ensureResponseTool(itemId, outputIndex, '', '')
      startTool(block, emitted)
      block.text += event.delta
      emitted.push({
        type: 'tool-call-delta',
        index: block.index,
        id: block.id,
        name: block.name,
        argumentsDelta: event.delta,
      })
    } else if (type === 'response.function_call_arguments.done') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : undefined
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined
      const block = ensureResponseTool(itemId, outputIndex, '', '')
      startTool(block, emitted)
      if (typeof event.arguments === 'string') block.text = event.arguments
    } else if (type === 'response.completed') {
      pendingUsage = mapUsage(event.response?.usage) ?? pendingUsage
      pendingFinish = toolBlocks.size > 0 ? { kind: 'tool-calls' } : { kind: 'stop' }
      terminalSeen = true
    } else if (type === 'response.incomplete') {
      pendingUsage = mapUsage(event.response?.usage) ?? pendingUsage
      pendingFinish = mapIncomplete(event)
      terminalSeen = true
    } else if (type === 'response.failed') {
      pendingUsage = mapUsage(event.response?.usage) ?? pendingUsage
      pendingFinish = {
        kind: 'error',
        failure: providerFailure(event, 'Grok response failed', 'PROVIDER'),
      }
      terminalSeen = true
    } else if (type === 'response.aborted' || type === 'response.cancelled' || type === 'response.canceled') {
      pendingUsage = mapUsage(event.response?.usage) ?? pendingUsage
      pendingFinish = {
        kind: 'aborted',
        failure: providerFailure(event, 'Grok response aborted', 'ABORTED'),
      }
      terminalSeen = true
    }
    if (isRecord(event.usage)) pendingUsage = mapUsage(event.usage) ?? pendingUsage
    return emitted
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      yield* finish()
      return
    }

    let event
    try {
      event = JSON.parse(payload)
    } catch {
      if (terminalSeen) continue
      throw coded('malformed Grok stream payload', 'MALFORMED_RESPONSE')
    }
    if (!isRecord(event)) continue
    if (isRecord(event.usage)) pendingUsage = mapUsage(event.usage) ?? pendingUsage
    if (terminalSeen) continue
    if (event.type === 'error') {
      const aborted = isAbortedMarker(event.reason)
        || isAbortedMarker(event.code)
        || isAbortedMarker(event.error?.reason)
        || isAbortedMarker(event.error?.code)
        || isAbortedMarker(event.error?.type)
      pendingFinish = {
        kind: aborted ? 'aborted' : 'error',
        failure: providerFailure(event, aborted ? 'Grok response aborted' : 'Grok response failed', aborted ? 'ABORTED' : 'PROVIDER'),
      }
      terminalSeen = true
      continue
    }
    if (typeof event.type === 'string' && event.type.startsWith('response.')) {
      for (const chunk of applyResponsesEvent(event)) yield chunk
      continue
    }
    if (Array.isArray(event.choices) && isRecord(event.choices[0])) {
      for (const chunk of applyChatDelta(event.choices[0])) yield chunk
    }
  }
  if (!terminalSeen) throw coded('SSE payload stream ended without a terminal event', 'STREAM_CLOSED')
  yield* finish()

  function* finish() {
    for (const block of order) {
      yield {
        type: 'block-end',
        index: block.index,
        block: closeBlock(block),
      }
    }
    if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
    const reason = pendingFinish ?? { kind: 'stop' }
    yield {
      type: 'finish',
      reason: reason.kind === 'stop' && order.length === 0
        ? {
          kind: 'error',
          failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' },
        }
        : reason,
    }
  }
}

function closeBlock(block) {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return { type: 'tool-call', id: block.id, name: block.name, arguments: block.text }
}

function mapFinish(reason) {
  if (reason === 'stop') return { kind: 'stop' }
  if (reason === 'tool_calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'cancelled' || reason === 'canceled' || reason === 'aborted' || reason === 'abort') {
    return { kind: 'aborted', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
}
