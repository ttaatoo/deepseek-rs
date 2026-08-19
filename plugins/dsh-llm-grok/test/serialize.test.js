import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeRequest } from '../src/serialize.js'

test('serializeRequest maps system text to instructions and user text to input', () => {
  const body = serializeRequest({
    model: 'grok-4.6',
    system: 'You are Grok.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    reasoningEffort: 'high',
  })
  assert.equal(body.model, 'grok-4.6')
  assert.equal(body.stream, true)
  assert.equal(body.instructions, 'You are Grok.')
  assert.deepEqual(body.input, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(body.reasoning, { effort: 'high' })
})

test('serializeRequest maps tool calls and tool results to Responses items', () => {
  const body = serializeRequest({
    model: 'grok-4.6',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'list' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'a.txt' }],
        }],
      },
    ],
    tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
  })
  assert.deepEqual(body.input, [
    { role: 'user', content: 'list' },
    { type: 'function_call', call_id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'a.txt' },
  ])
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'bash',
    description: 'run a command',
    parameters: { type: 'object' },
  }])
})

test('serializeRequest rejects image content', () => {
  assert.throws(
    () => serializeRequest({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { id: 'x' } }] }],
    }),
    (error) => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('serializeRequest rejects image content nested in a tool result', () => {
  assert.throws(
    () => serializeRequest({
      model: 'grok-4.6',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'call-1',
          content: [{ type: 'image', attachment: { id: 'nested-image' } }],
        }],
      }],
    }),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('serializeRequest rejects stop sequences', () => {
  assert.throws(
    () => serializeRequest({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stop: ['END'],
    }),
    (error) => error.code === 'UNSUPPORTED',
  )
})

test('serializeRequest disables reasoning for session-title calls', () => {
  const body = serializeRequest({
    model: 'grok-4.6',
    purpose: 'session-title',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'title' }] }],
    reasoningEffort: 'high',
  })
  assert.equal(body.reasoning, undefined)
})
