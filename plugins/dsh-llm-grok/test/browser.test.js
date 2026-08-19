import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserLaunchSpec, openSystemBrowser } from '../src/browser.js'

test('browserLaunchSpec uses explorer without cmd shell parsing on Windows', () => {
  const url = 'https://auth.x.ai/activate?user_code=ABCD%26EFGH'
  assert.deepEqual(browserLaunchSpec(url, 'win32'), {
    command: 'explorer.exe',
    args: [url],
  })
})

test('browserLaunchSpec rejects non-https and untrusted origins', () => {
  assert.throws(() => browserLaunchSpec('http://auth.x.ai/activate'), /https/)
  assert.throws(() => browserLaunchSpec('https://evil.example/activate'), /trusted|origin/)
  assert.throws(() => browserLaunchSpec('https://evil.example/activate', 'win32', ['https://evil.example']), /trusted|origin/)
})

test('openSystemBrowser uses the validated Windows launch spec', async () => {
  const calls = []
  const url = 'https://auth.x.ai/activate?user_code=ABCD'
  await openSystemBrowser(url, {
    platform: 'win32',
    spawn: async (command, args) => { calls.push({ command, args }) },
  })
  assert.deepEqual(calls, [{ command: 'explorer.exe', args: [url] }])
})
