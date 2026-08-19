import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeviceCodeBody,
  buildRefreshBody,
  buildTokenBody,
  createAuthRuntime,
  createLoginController,
  discoverEndpoints,
  ensureFreshSession,
  parseDeviceCodeResponse,
  parseTokenResponse,
  refreshSession,
} from '../src/oauth.js'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSession, writeSession } from '../src/session.js'

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('test condition did not become true')
}

function missingCliAuthPath(dir) {
  return join(dir, 'missing-cli-auth.json')
}

function storedSession(overrides = {}) {
  return {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
    email: 'user@example.com',
    userId: 'user-1',
    ...overrides,
  }
}

test('buildDeviceCodeBody posts the public client and CLI scopes', () => {
  const body = buildDeviceCodeBody({
    clientId: 'client-1',
    scope: 'openid grok-cli:access',
  })
  assert.equal(body.get('client_id'), 'client-1')
  assert.equal(body.get('scope'), 'openid grok-cli:access')
})

test('parseDeviceCodeResponse reads RFC 8628 fields', () => {
  const parsed = parseDeviceCodeResponse({
    device_code: 'dev-1',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://auth.x.ai/activate',
    verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  })
  assert.deepEqual(parsed, {
    deviceCode: 'dev-1',
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://auth.x.ai/activate',
    verificationUrlComplete: 'https://auth.x.ai/activate?user_code=ABCD-EFGH',
    expiresIn: 600,
    interval: 5,
  })
})

test('parseDeviceCodeResponse rejects a missing device_code', () => {
  assert.equal(parseDeviceCodeResponse({ user_code: 'ABCD' }), undefined)
})

test('parseTokenResponse keeps the previous refresh token when the server omits one', () => {
  const session = parseTokenResponse({
    access_token: 'new-access',
    expires_in: 120,
  }, 1_700_000_000_000, { refreshToken: 'old-refresh', email: 'keep@example.com' })
  assert.equal(session.accessToken, 'new-access')
  assert.equal(session.refreshToken, 'old-refresh')
  assert.equal(session.email, 'keep@example.com')
  assert.equal(session.expiresAt, new Date(1_700_000_000_000 + 120_000).toISOString())
})

test('parseTokenResponse reads email from the id_token payload', () => {
  const payload = Buffer.from(JSON.stringify({
    email: 'from-id@example.com',
    sub: 'sub-1',
  })).toString('base64url')
  const session = parseTokenResponse({
    access_token: 'a',
    refresh_token: 'r',
    expires_in: 60,
    id_token: `hdr.${payload}.sig`,
  }, 0)
  assert.equal(session.email, 'from-id@example.com')
  assert.equal(session.userId, 'sub-1')
})

test('buildTokenBody uses the device_code grant', () => {
  const body = buildTokenBody({ clientId: 'c', deviceCode: 'd' })
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(body.get('device_code'), 'd')
})

test('buildRefreshBody uses the refresh_token grant', () => {
  const body = buildRefreshBody({ clientId: 'c', refreshToken: 'r' })
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'r')
})

test('discoverEndpoints rejects a discovery document from another issuer', async () => {
  const endpoints = await discoverEndpoints('https://auth.x.ai', async () => new Response(JSON.stringify({
      issuer: 'https://evil.example',
      device_authorization_endpoint: 'https://evil.example/device',
      token_endpoint: 'https://evil.example/token',
      userinfo_endpoint: 'https://evil.example/userinfo',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  assert.deepEqual(endpoints, {
    deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    userinfoEndpoint: 'https://auth.x.ai/oauth2/userinfo',
  })
})

test('discovery issuer comparison uses the raw configured issuer value', async () => {
  const endpoints = await discoverEndpoints('https://auth.x.ai/', async () => new Response(JSON.stringify({
    issuer: 'https://auth.x.ai',
    device_authorization_endpoint: 'https://auth.x.ai/custom-device',
    token_endpoint: 'https://auth.x.ai/custom-token',
    userinfo_endpoint: 'https://auth.x.ai/custom-userinfo',
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  assert.deepEqual(endpoints, {
    deviceAuthorizationEndpoint: 'https://auth.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    userinfoEndpoint: 'https://auth.x.ai/oauth2/userinfo',
  })
})

test('discovery cannot widen the fixed xAI origin allowlist', async () => {
  await assert.rejects(
    discoverEndpoints('https://evil.example', async () => new Response('{}', { status: 404 }), ['https://evil.example']),
    /invalid OAuth issuer/,
  )
})

test('parseDeviceCodeResponse rejects non-https and untrusted verification URLs', () => {
  const base = { device_code: 'device', user_code: 'ABCD' }
  assert.equal(parseDeviceCodeResponse({
    ...base,
    verification_uri: 'http://auth.x.ai/activate',
  }), undefined)
  assert.equal(parseDeviceCodeResponse({
    ...base,
    verification_uri: 'https://evil.example/activate',
  }), undefined)
  assert.equal(parseDeviceCodeResponse({
    ...base,
    verification_uri: 'https://auth.x.ai/activate',
    verification_uri_complete: 'https://evil.example/activate?code=ABCD',
  }), undefined)
})

test('refreshSession marks token-bearing requests as non-redirecting', async () => {
  const calls = []
  const runtime = createAuthRuntime({
    issuer: 'https://auth.x.ai',
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response('{}', { status: 404 })
      }
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const session = await refreshSession(runtime, {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
    email: 'user@example.com',
    userId: 'user-1',
  })
  assert.equal(session.accessToken, 'new-access')
  const tokenCall = calls.find(({ url }) => url.endsWith('/oauth2/token'))
  assert.equal(tokenCall.options.redirect, 'error')
})

test('userinfo enrichment also disables redirects for its bearer request', async () => {
  let userinfoOptions
  const runtime = createAuthRuntime({
    issuer: 'https://auth.x.ai',
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      userinfoOptions = options
      return new Response(JSON.stringify({ email: 'user@example.com', sub: 'user-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const session = await refreshSession(runtime, {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
  })
  assert.equal(session.email, 'user@example.com')
  assert.equal(userinfoOptions.redirect, 'error')
})

test('ensureFreshSession keeps the stored session after a network refresh failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  const original = {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
    email: 'user@example.com',
    userId: 'user-1',
  }
  await writeSession(path, original)
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      throw new Error('network down')
    },
  })
  assert.equal(await ensureFreshSession(runtime), undefined)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original)
})

test('ensureFreshSession keeps the stored session after malformed and 5xx refresh responses', async () => {
  for (const response of [
    new Response('{', { status: 200 }),
    new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }),
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
    const path = join(dir, 'grok-oauth.json')
    const original = {
      version: 1,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }
    await writeSession(path, original)
    const runtime = createAuthRuntime({
      resolveSessionPath: () => path,
      grokCliAuthPath: missingCliAuthPath(dir),
      fetch: async (url) => {
        if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
        return response
      },
    })
    assert.equal(await ensureFreshSession(runtime), undefined)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original)
  }
})

test('ensureFreshSession keeps the stored session when a 5xx body mentions invalid_grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  const original = {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
  }
  await writeSession(path, original)
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(await ensureFreshSession(runtime), undefined)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original)
})

test('ensureFreshSession removes the stored session only for invalid_grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
  })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(await ensureFreshSession(runtime), undefined)
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
})

test('ensureFreshSession shares one in-flight refresh per session path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
  })
  let tokenCalls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      tokenCalls += 1
      await gate
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = ensureFreshSession(runtime)
  const second = ensureFreshSession(runtime)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(tokenCalls, 1)
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.accessToken, 'new-access')
  assert.equal(right.accessToken, 'new-access')
})

test('device authorization failures become an error status after polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let tokenOptions
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    openBrowser: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 1,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      tokenOptions = options
      return new Response(JSON.stringify({ error: 'access_denied' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const controller = createLoginController(runtime)
  assert.equal((await controller.start()).kind, 'pending')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(await controller.status(), {
    kind: 'error',
    message: 'xAI device authorization was denied.',
  })
  assert.equal(tokenOptions.redirect, 'error')
})

test('logout invalidates an in-flight refresh before it can write the old session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let refreshStarted
  const refreshReady = new Promise(resolve => { refreshStarted = resolve })
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      refreshStarted()
      await refreshGate
      return new Response(JSON.stringify({
        access_token: 'refreshed-access',
        refresh_token: 'refreshed-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const refresh = ensureFreshSession(runtime)
  await refreshReady
  await createLoginController(runtime).logout()
  assert.equal(await readSession(path), undefined)
  releaseRefresh()
  assert.equal(await refresh, undefined)
  assert.equal(await readSession(path), undefined)
})

test('a new device login cannot be overwritten by an older refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let refreshStarted
  const refreshReady = new Promise(resolve => { refreshStarted = resolve })
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  let loginTokenStarted
  const loginReady = new Promise(resolve => { loginTokenStarted = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    openBrowser: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 10,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/oauth2/userinfo')) {
        return new Response(JSON.stringify({ email: 'user@example.com', sub: 'user-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (options.body.get('grant_type') === 'refresh_token') {
        refreshStarted()
        await refreshGate
        return new Response(JSON.stringify({
          access_token: 'refreshed-access',
          refresh_token: 'refreshed-refresh',
          expires_in: 600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      loginTokenStarted()
      return new Response(JSON.stringify({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const refresh = ensureFreshSession(runtime)
  await refreshReady
  const controller = createLoginController(runtime)
  assert.equal((await controller.start()).kind, 'pending')
  await loginReady
  await waitFor(async () => (await readSession(path))?.refreshToken === 'login-refresh')
  releaseRefresh()
  await refresh
  assert.equal((await readSession(path))?.refreshToken, 'login-refresh')
})

test('invalid_grant from an older refresh cannot delete a newly saved login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let refreshStarted
  const refreshReady = new Promise(resolve => { refreshStarted = resolve })
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  let loginTokenStarted
  const loginReady = new Promise(resolve => { loginTokenStarted = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    openBrowser: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 10,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/oauth2/userinfo')) {
        return new Response(JSON.stringify({ email: 'user@example.com', sub: 'user-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (options.body.get('grant_type') === 'refresh_token') {
        refreshStarted()
        await refreshGate
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      loginTokenStarted()
      return new Response(JSON.stringify({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const refresh = ensureFreshSession(runtime)
  await refreshReady
  const controller = createLoginController(runtime)
  assert.equal((await controller.start()).kind, 'pending')
  await loginReady
  await waitFor(async () => (await readSession(path))?.refreshToken === 'login-refresh')
  releaseRefresh()
  await refresh
  assert.equal((await readSession(path))?.refreshToken, 'login-refresh')
})

test('refresh single-flight is isolated between runtime instances sharing a path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let tokenCalls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const makeRuntime = () => createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      tokenCalls += 1
      await gate
      return new Response(JSON.stringify({
        access_token: `access-${tokenCalls}`,
        refresh_token: `refresh-${tokenCalls}`,
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = ensureFreshSession(makeRuntime())
  const second = ensureFreshSession(makeRuntime())
  await waitFor(() => tokenCalls === 2)
  release()
  await Promise.all([first, second])
  assert.equal(tokenCalls, 2)
})

test('an old device poll cannot clear the second login state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let deviceCalls = 0
  let firstPollStarted
  let secondPollStarted
  const firstPollReady = new Promise(resolve => { firstPollStarted = resolve })
  const secondPollReady = new Promise(resolve => { secondPollStarted = resolve })
  let releaseFirstPoll
  let releaseSecondPoll
  const firstPoll = new Promise(resolve => { releaseFirstPoll = resolve })
  const secondPoll = new Promise(resolve => { releaseSecondPoll = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    openBrowser: async () => {},
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        deviceCalls += 1
        return new Response(JSON.stringify({
          device_code: `device-${deviceCalls}`,
          user_code: `CODE-${deviceCalls}`,
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 60,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/oauth2/token')) {
        const deviceCode = options.body.get('device_code')
        if (deviceCode === 'device-1') {
          firstPollStarted()
          return firstPoll
        }
        secondPollStarted()
        return secondPoll
      }
      return new Response(JSON.stringify({ email: 'user@example.com', sub: 'user-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const controller = createLoginController(runtime)
  assert.equal((await controller.start()).kind, 'pending')
  await firstPollReady
  assert.equal((await controller.start()).kind, 'pending')
  await secondPollReady

  releaseFirstPoll(new Response(JSON.stringify({
    access_token: 'first-access',
    refresh_token: 'first-refresh',
    expires_in: 600,
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await controller.status(), {
    kind: 'pending',
    userCode: 'CODE-2',
    verificationUrl: 'https://auth.x.ai/activate',
  })

  releaseSecondPoll(new Response(JSON.stringify({
    access_token: 'second-access',
    refresh_token: 'second-refresh',
    expires_in: 600,
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await waitFor(async () => (await controller.status()).kind === 'signed-in')
})

test('logout tombstone blocks CLI import until an explicit login starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  const tombstonePath = join(dir, '.grok-oauth.json.signed-out')
  const cliPath = join(dir, 'cli-auth.json')
  await writeFile(cliPath, JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: 'cli-access',
      refresh_token: 'cli-refresh',
      expires_at: '2099-01-01T00:00:00.000Z',
    },
  }), { encoding: 'utf8', mode: 0o600 })
  let deviceCalls = 0
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: cliPath,
    openBrowser: async () => {},
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      deviceCalls += 1
      return new Response(JSON.stringify({
        device_code: 'device',
        user_code: 'ABCD',
        verification_uri: 'https://auth.x.ai/activate',
        expires_in: 60,
        interval: 60,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const controller = createLoginController(runtime)
  await controller.logout()
  assert.deepEqual(await readdir(dir), ['.grok-oauth.json.signed-out', 'cli-auth.json'])
  assert.equal((await readFile(tombstonePath, 'utf8')), 'signed-out\n')
  assert.equal((await stat(tombstonePath)).mode & 0o777, 0o600)
  assert.deepEqual(await controller.status(), { kind: 'signed-out' })
  assert.equal(await readFile(cliPath, 'utf8').then(value => value.includes('cli-refresh')), true)

  assert.equal((await controller.start()).kind, 'pending')
  assert.equal(deviceCalls, 1)
  assert.deepEqual(await readdir(dir), ['cli-auth.json'])
  await controller.cancel()
})

test('parallel runtime refreshes both return a shared committed session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let tokenCalls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const makeRuntime = () => createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      tokenCalls += 1
      await gate
      return new Response(JSON.stringify({
        access_token: 'shared-access',
        refresh_token: 'shared-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = ensureFreshSession(makeRuntime())
  const second = ensureFreshSession(makeRuntime())
  await waitFor(() => tokenCalls === 2)
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left?.refreshToken, 'shared-refresh')
  assert.equal(right?.refreshToken, 'shared-refresh')
  assert.equal((await readSession(path))?.refreshToken, 'shared-refresh')
})

test('a successful refresh can commit after another runtime removes the old session for invalid_grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let invalidGrantStarted
  let successStarted
  const invalidGrantReady = new Promise(resolve => { invalidGrantStarted = resolve })
  const successReady = new Promise(resolve => { successStarted = resolve })
  let releaseInvalidGrant
  let releaseSuccess
  const invalidGrantGate = new Promise(resolve => { releaseInvalidGrant = resolve })
  const successGate = new Promise(resolve => { releaseSuccess = resolve })
  const makeRuntime = (kind) => createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (kind === 'invalid-grant') {
        invalidGrantStarted()
        await invalidGrantGate
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      successStarted()
      await successGate
      return new Response(JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const invalidGrant = ensureFreshSession(makeRuntime('invalid-grant'))
  await invalidGrantReady
  const success = ensureFreshSession(makeRuntime('success'))
  await successReady
  releaseInvalidGrant()
  assert.equal(await invalidGrant, undefined)
  assert.equal(await readSession(path), undefined)
  releaseSuccess()
  assert.equal((await success)?.refreshToken, 'new-refresh')
  assert.equal((await readSession(path))?.refreshToken, 'new-refresh')
})

test('a later cross-runtime rotating refresh returns the committed session without metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, {
    version: 1,
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2020-01-01T00:00:00.000Z',
  })
  let firstStarted
  let secondStarted
  const firstReady = new Promise(resolve => { firstStarted = resolve })
  const secondReady = new Promise(resolve => { secondStarted = resolve })
  let releaseFirst
  let releaseSecond
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const secondGate = new Promise(resolve => { releaseSecond = resolve })
  const makeRuntime = (kind) => createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/userinfo')) return new Response('{}', { status: 404 })
      if (kind === 'first') {
        firstStarted()
        await firstGate
        return new Response(JSON.stringify({
          access_token: 'first-access',
          refresh_token: 'first-refresh',
          expires_in: 600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      secondStarted()
      await secondGate
      return new Response(JSON.stringify({
        access_token: 'second-access',
        refresh_token: 'second-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = ensureFreshSession(makeRuntime('first'))
  await firstReady
  const second = ensureFreshSession(makeRuntime('second'))
  await secondReady
  releaseFirst()
  assert.equal((await first)?.refreshToken, 'first-refresh')
  assert.equal((await readSession(path))?.refreshToken, 'first-refresh')
  releaseSecond()
  assert.equal((await second)?.refreshToken, 'first-refresh')
  assert.equal((await readSession(path))?.refreshToken, 'first-refresh')
})

test('cancel in one runtime does not invalidate another runtime refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, storedSession())
  let refreshStarted
  const refreshReady = new Promise(resolve => { refreshStarted = resolve })
  let releaseRefresh
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve })
  const runtimeA = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
  })
  const runtimeB = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      refreshStarted()
      await refreshGate
      return new Response(JSON.stringify({
        access_token: 'runtime-b-access',
        refresh_token: 'runtime-b-refresh',
        expires_in: 600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const refresh = ensureFreshSession(runtimeB)
  await refreshReady
  await createLoginController(runtimeA).cancel()
  releaseRefresh()
  assert.equal((await refresh)?.refreshToken, 'runtime-b-refresh')
})

test('login discovery timeout clears a never-resolving fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let discoverySignal
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    timeoutMs: 100,
    requestTimeoutMs: 20,
    fetch: async (_url, options) => {
      discoverySignal = options.signal
      return new Promise(() => {})
    },
  })
  const controller = createLoginController(runtime)
  const result = await Promise.race([
    controller.start(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('login discovery hung')), 150)),
  ])
  assert.deepEqual(result, { kind: 'error', message: 'xAI device authorization failed.' })
  assert.equal(discoverySignal.aborted, true)
  assert.deepEqual(await controller.status(), {
    kind: 'error',
    message: 'xAI device authorization failed.',
  })
})

test('login timeout aborts a never-resolving token poll and clears pending state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let tokenSignal
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    timeoutMs: 30,
    requestTimeoutMs: 1_000,
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 60,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      tokenSignal = options.signal
      return new Promise(() => {})
    },
  })
  const controller = createLoginController(runtime)
  assert.deepEqual((await controller.start()).kind, 'pending')
  await waitFor(async () => (await controller.status()).kind === 'error', 300)
  assert.equal(tokenSignal.aborted, true)
  assert.deepEqual(await controller.status(), {
    kind: 'error',
    message: 'xAI device authorization timed out.',
  })
})

test('refresh timeout keeps the session after a never-resolving token fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  const original = storedSession()
  await writeSession(path, original)
  let tokenSignal
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    requestTimeoutMs: 20,
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      tokenSignal = options.signal
      return new Promise(() => {})
    },
  })
  const refreshed = await Promise.race([
    ensureFreshSession(runtime),
    new Promise((_, reject) => setTimeout(() => reject(new Error('refresh hung')), 150)),
  ])
  assert.equal(refreshed, undefined)
  assert.equal(tokenSignal.aborted, true)
  assert.deepEqual(await readSession(path), original)
})

test('userinfo timeout does not hang a successful token response', async () => {
  let userinfoSignal
  const runtime = createAuthRuntime({
    requestTimeoutMs: 20,
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      userinfoSignal = options.signal
      return new Promise(() => {})
    },
  })
  const refreshed = await Promise.race([
    refreshSession(runtime, {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('userinfo hung')), 150)),
  ])
  assert.equal(refreshed?.refreshToken, 'new-refresh')
  assert.equal(userinfoSignal.aborted, true)
})

test('cancel aborts an in-flight discovery request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let discoveryStarted
  const started = new Promise(resolve => { discoveryStarted = resolve })
  let discoverySignal
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (_url, options) => {
      discoverySignal = options.signal
      discoveryStarted()
      return new Promise(() => {})
    },
  })
  const controller = createLoginController(runtime)
  const start = controller.start()
  await started
  assert.deepEqual(await controller.cancel(), { ok: true })
  assert.equal(discoverySignal.aborted, true)
  assert.deepEqual(await start, {
    kind: 'error',
    message: 'xAI device authorization cancelled.',
  })
  assert.deepEqual(await controller.status(), { kind: 'signed-out' })
})

test('logout aborts an in-flight device-code request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let deviceStarted
  const started = new Promise(resolve => { deviceStarted = resolve })
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      deviceStarted(options.signal)
      return new Promise(() => {})
    },
  })
  const controller = createLoginController(runtime)
  const start = controller.start()
  const deviceSignal = await started
  await controller.logout()
  assert.equal(deviceSignal.aborted, true)
  assert.deepEqual(await start, {
    kind: 'error',
    message: 'xAI device authorization cancelled.',
  })
  assert.deepEqual(await controller.status(), { kind: 'signed-out' })
})

test('cancel aborts userinfo enrichment without saving the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  let userinfoStarted
  const started = new Promise(resolve => { userinfoStarted = resolve })
  let userinfoSignal
  const runtime = createAuthRuntime({
    resolveSessionPath: () => path,
    grokCliAuthPath: missingCliAuthPath(dir),
    fetch: async (url, options) => {
      if (url.endsWith('/.well-known/openid-configuration')) return new Response('{}', { status: 404 })
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(JSON.stringify({
          device_code: 'device',
          user_code: 'ABCD',
          verification_uri: 'https://auth.x.ai/activate',
          expires_in: 60,
          interval: 0.001,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      userinfoSignal = options.signal
      userinfoStarted()
      return new Promise(() => {})
    },
  })
  const controller = createLoginController(runtime)
  assert.equal((await controller.start()).kind, 'pending')
  await started
  await controller.cancel()
  assert.equal(userinfoSignal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await controller.status(), { kind: 'signed-out' })
  assert.equal(await readSession(path), undefined)
})
