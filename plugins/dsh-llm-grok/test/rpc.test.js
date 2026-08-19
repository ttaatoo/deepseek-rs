import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGrokRpcHandler } from '../src/rpc.js'

test('createGrokRpcHandler routes start/status/logout/cancel', async () => {
  const calls = []
  const controller = {
    start: async () => { calls.push('start'); return { kind: 'pending', userCode: 'ABCD' } },
    status: async () => { calls.push('status'); return { kind: 'signed-out' } },
    logout: async () => { calls.push('logout'); return { ok: true } },
    cancel: async () => { calls.push('cancel'); return { ok: true } },
  }
  const handle = createGrokRpcHandler(controller)
  assert.deepEqual(await handle('auth/start'), { ok: true, value: { kind: 'pending', userCode: 'ABCD' } })
  assert.deepEqual(await handle('auth/status'), { ok: true, value: { kind: 'signed-out' } })
  assert.equal((await handle('auth/unknown')).ok, false)
  assert.deepEqual(calls, ['start', 'status'])
})

test('createGrokRpcHandler forwards a transport AbortSignal when provided', async () => {
  const controllerSignal = new AbortController().signal
  let receivedSignal
  const controller = {
    start: async (options) => {
      receivedSignal = options?.signal
      return { kind: 'pending' }
    },
  }
  const handle = createGrokRpcHandler(controller)
  await handle('auth/start', { generation: 1 }, { signal: controllerSignal })
  assert.equal(receivedSignal, controllerSignal)
})
