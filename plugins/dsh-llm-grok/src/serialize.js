/** @typedef {Error & { code: string }} CodedError */

/** @returns {CodedError} */
function coded(message, code) {
  const error = /** @type {CodedError} */ (new Error(message))
  error.code = code
  return error
}

function flattenText(blocks) {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function assertTextOnly(blocks) {
  if (blocks.some(block => (
    block.type === 'image'
    || (block.type === 'tool-result' && assertNestedTextOnly(block.content))
  ))) {
    throw coded('The Grok adapter does not send image content.', 'UNSUPPORTED_CONTENT')
  }
}

function assertNestedTextOnly(blocks) {
  return blocks.some(block => (
    block.type === 'image'
    || (block.type === 'tool-result' && assertNestedTextOnly(block.content))
  ))
}

function serializeMessages(messages) {
  const input = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text.length > 0) input.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      if (text.length > 0) input.push({ role: 'assistant', content: text })
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: block.arguments,
          })
        }
      }
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      input.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: flattenText(result.content) || '(no output)',
      })
    }
  }
  return input
}

export function serializeRequest(options) {
  if (options.stop !== undefined && options.stop.length > 0) {
    throw coded('Grok Responses does not accept stop sequences.', 'UNSUPPORTED')
  }
  const system = options.system
  const input = serializeMessages(options.messages)
  const body = {
    model: options.model,
    stream: true,
    input,
  }
  if (typeof system === 'string' && system.length > 0) body.instructions = system
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  const effort = options.purpose === 'session-title' ? undefined : options.reasoningEffort
  if (typeof effort === 'string' && effort.length > 0 && effort !== 'none' && effort !== 'off') {
    body.reasoning = { effort }
  }
  return body
}
