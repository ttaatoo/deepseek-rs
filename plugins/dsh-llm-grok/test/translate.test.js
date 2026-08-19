import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate } from '../src/translate.js'

async function collect(payloads) {
  const chunks = []
  async function* source() {
    for (const payload of payloads) yield payload
  }
  for await (const chunk of translate(source())) chunks.push(chunk)
  return chunks
}

test('translate maps Responses text deltas and completed usage', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'Hel' }),
    JSON.stringify({ type: 'response.output_text.delta', delta: 'lo' }),
    JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 2 } },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hel' })
  assert.deepEqual(chunks[2], { type: 'text-delta', index: 0, text: 'lo' })
  assert.deepEqual(chunks.at(-3), { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translate maps response.text.delta to the text block', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.text.delta', delta: 'plain' }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'plain' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'plain' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('translate emits reasoning-delta for Responses reasoning blocks', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'think' }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('translate maps chat-completions tool call fragments', async () => {
  const chunks = await collect([
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'bash', arguments: '{"c"' } }] },
      }],
    }),
    JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    '[DONE]',
  ])
  assert.equal(chunks[0].blockType, 'tool-call')
  assert.equal(chunks.find(chunk => chunk.type === 'tool-call-delta').id, 'call-1')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(end.block.arguments, '{"c":1}')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('translate keeps two parallel Chat tool calls by wire index', async () => {
  const chunks = await collect([
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call-a', function: { name: 'one', arguments: '{"a":' } },
            { index: 1, id: 'call-b', function: { name: 'two', arguments: '{"b":' } },
          ],
        },
      }],
    }),
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: '2}' } },
            { index: 0, function: { arguments: '1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'call-a', name: 'one', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'call-b', name: 'two', arguments: '{"b":2}' },
  ])
})

test('translate records usage from a Chat choices-empty chunk', async () => {
  const chunks = await collect([
    JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } })
})

test('translate keeps trailing usage after a Chat terminal choice', async () => {
  const chunks = await collect([
    JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: null }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 1 } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translate preserves Responses usage-only event before completed', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
    JSON.stringify({ type: 'response.usage', usage: { input_tokens: 7, output_tokens: 3 } }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translate preserves Responses usage-only event before incomplete', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
    JSON.stringify({ type: 'response.usage', usage: { input_tokens: 7, output_tokens: 3 } }),
    JSON.stringify({ type: 'response.incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('translate maps a top-level provider error to an error finish', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'error', code: 'rate_limit', message: 'slow down' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'slow down', code: 'rate_limit' } },
  }])
})

test('translate maps a top-level aborted error event to aborted', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'error', reason: 'aborted', error: { message: 'cancelled by caller' } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'cancelled by caller', code: 'ABORTED' } },
  }])
})

test('translate maps a top-level error code aborted marker to aborted', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'error', code: 'aborted', message: 'provider stopped' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'provider stopped', code: 'aborted' } },
  }])
})

test('translate maps a nested error type aborted marker to aborted', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'error', error: { type: 'aborted', message: 'provider stopped' } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'provider stopped', code: 'aborted' } },
  }])
})

test('translate preserves the provider failure from response.failed', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'server_error', message: 'upstream failed' } },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'upstream failed', code: 'server_error' } },
  }])
})

test('translate preserves usage on response.failed terminal events', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
    JSON.stringify({
      type: 'response.failed',
      response: {
        usage: { input_tokens: 7, output_tokens: 3 },
        error: { code: 'server_error', message: 'upstream failed' },
      },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'upstream failed', code: 'server_error' } },
  })
})

test('translate maps a response.aborted terminal event to aborted', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.aborted',
      error: { code: 'client_cancelled', message: 'request cancelled' },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'request cancelled', code: 'client_cancelled' } },
  }])
})

test('translate preserves usage on response.aborted terminal events', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
    JSON.stringify({
      type: 'response.aborted',
      response: {
        usage: { input_tokens: 7, output_tokens: 3 },
        error: { code: 'client_cancelled', message: 'request cancelled' },
      },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'request cancelled', code: 'client_cancelled' } },
  })
})

test('translate preserves usage on response.cancelled terminal events', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }),
    JSON.stringify({
      type: 'response.cancelled',
      response: {
        usage: { input_tokens: 7, output_tokens: 3 },
        error: { code: 'client_cancelled', message: 'request cancelled' },
      },
    }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } })
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'request cancelled', code: 'client_cancelled' } },
  })
})

test('translate maps an incomplete response without response details to max-tokens', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'max-tokens' } }])
})

test('translate maps an unknown incomplete reason to an error finish', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.incomplete', incomplete_details: { reason: 'content_filter' } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'model incomplete: content_filter', code: 'content_filter' },
    },
  }])
})

test('translate maps a Chat cancelled finish reason to aborted', async () => {
  const chunks = await collect([
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'cancelled' }] }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [{
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'model stopped: cancelled', code: 'CANCELLED' } },
  }])
})

test('translate ignores late text and tool events after the first terminal event', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'first' }),
    JSON.stringify({ type: 'response.completed' }),
    JSON.stringify({ type: 'response.output_text.delta', delta: 'late' }),
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'item-late', call_id: 'call-late', name: 'late', arguments: '' },
    }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-late', output_index: 1, delta: '{}' }),
    JSON.stringify({ type: 'response.failed', response: { error: { code: 'late_error', message: 'late terminal' } } }),
    '[DONE]',
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'first' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'first' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('translate finishes a Responses stream that omits [DONE]', async () => {
  const chunks = await collect([
    JSON.stringify({ type: 'response.output_text.delta', delta: 'pong' }),
    JSON.stringify({ type: 'response.completed' }),
  ])
  assert.deepEqual(chunks.at(-2), { type: 'block-end', index: 0, block: { type: 'text', text: 'pong' } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translate reports STREAM_CLOSED when payload EOF has no terminal event', async () => {
  await assert.rejects(
    () => collect([
      JSON.stringify({ type: 'response.output_text.delta', delta: 'pong' }),
    ]),
    error => error.code === 'STREAM_CLOSED',
  )
})

test('translate maps a completed Responses function call', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'call-9', name: 'bash', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.function_call_arguments.delta',
      delta: '{"command":"pwd"}',
    }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(end.block, {
    type: 'tool-call',
    id: 'call-9',
    name: 'bash',
    arguments: '{"command":"pwd"}',
  })
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
})

test('translate uses the final Responses function-call arguments from done', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'bash', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      output_index: 0,
      delta: '{"partial":',
    }),
    JSON.stringify({
      type: 'response.function_call_arguments.done',
      item_id: 'item-1',
      output_index: 0,
      arguments: '{"complete":true}',
    }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, {
    type: 'tool-call',
    id: 'call-1',
    name: 'bash',
    arguments: '{"complete":true}',
  })
})

test('translate keeps parallel Responses function-call done arguments on their own blocks', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'one', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'two', arguments: '' },
    }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-a', output_index: 0, delta: '{"partial":' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-b', output_index: 1, delta: '{"partial":' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'item-b', output_index: 1, arguments: '{"b":2}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'item-a', output_index: 0, arguments: '{"a":1}' }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'call-a', name: 'one', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'call-b', name: 'two', arguments: '{"b":2}' },
  ])
})

test('translate uses final arguments from response.output_item.done', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'bash', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'bash', arguments: '{"complete":true}' },
    }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, {
    type: 'tool-call',
    id: 'call-1',
    name: 'bash',
    arguments: '{"complete":true}',
  })
})

test('translate keeps parallel response.output_item.done arguments on their own blocks', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'one', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'two', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'two', arguments: '{"b":2}' },
    }),
    JSON.stringify({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'one', arguments: '{"a":1}' },
    }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'call-a', name: 'one', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'call-b', name: 'two', arguments: '{"b":2}' },
  ])
})

test('translate starts each Responses tool block only once', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'bash', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      output_index: 0,
      delta: '{',
    }),
    JSON.stringify({
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      output_index: 0,
      delta: '}',
    }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start'), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end').block, {
    type: 'tool-call',
    id: 'call-1',
    name: 'bash',
    arguments: '{}',
  })
})

test('translate keeps interleaved Responses tool calls keyed by item id and output index', async () => {
  const chunks = await collect([
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'one', arguments: '' },
    }),
    JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'two', arguments: '' },
    }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-a', output_index: 0, delta: '{"a":' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-b', output_index: 1, delta: '{"b":' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-a', output_index: 0, delta: '1}' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item-b', output_index: 1, delta: '2}' }),
    JSON.stringify({ type: 'response.completed' }),
    '[DONE]',
  ])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'tool-call', id: 'call-a', name: 'one', arguments: '{"a":1}' },
    { type: 'tool-call', id: 'call-b', name: 'two', arguments: '{"b":2}' },
  ])
})
