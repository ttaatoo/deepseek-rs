import {
  DEFAULT_POLL_INTERVAL_MS,
  DEVICE_CODE_PATH,
  LOGIN_TIMEOUT_MS,
  OAUTH_CLIENT_ID,
  OAUTH_ISSUER,
  OAUTH_SCOPE,
  OPENID_CONFIG_PATH,
  REFRESH_SKEW_MS,
  TOKEN_PATH,
  USERINFO_PATH,
} from './constants.js'
import {
  deleteSession,
  deleteSignOutTombstone,
  hasSignOutTombstone,
  readGrokCliSession,
  readSession,
  sessionNeedsRefresh,
  writeSignOutTombstone,
  writeSession,
} from './session.js'
import { resolve as resolvePath } from 'node:path'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record, key) {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function joinUrl(issuer, path) {
  return `${issuer.replace(/\/+$/u, '')}${path}`
}

function issuerContext(issuer) {
  if (typeof issuer !== 'string' || issuer.length === 0) return undefined
  let parsed
  try {
    parsed = new URL(issuer)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  const trustedOrigin = new URL(OAUTH_ISSUER).origin
  if (parsed.origin !== trustedOrigin) return undefined
  return { issuer, origins: new Set([trustedOrigin]) }
}

function trustedHttpsUrl(value, context) {
  if (
    typeof value !== 'string'
    || /[\u0000-\u001f\u007f]/u.test(value)
    || context === undefined
  ) return undefined
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return undefined
  if (!context.origins.has(parsed.origin)) return undefined
  return parsed.href
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
}

function abortError(message, name = 'AbortError') {
  const error = new Error(message)
  error.name = name
  return error
}

function finiteTimeout(value, fallback = DEFAULT_REQUEST_TIMEOUT_MS) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function requestTimeoutMs(runtime) {
  if (runtime.requestTimeoutMs !== undefined) return finiteTimeout(runtime.requestTimeoutMs)
  return finiteTimeout(Math.min(finiteTimeout(runtime.timeoutMs), DEFAULT_REQUEST_TIMEOUT_MS))
}

function readSignal(value) {
  if (isAbortSignal(value)) return value
  if (isRecord(value) && isAbortSignal(value.signal)) return value.signal
  return undefined
}

function createAbortScope(parentSignals, timeoutMs, onTimeout, onParentAbort) {
  const controller = new AbortController()
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  void aborted.catch(() => {})
  const listeners = []
  let timer

  const abort = (reason) => {
    if (controller.signal.aborted) return
    const error = reason instanceof Error ? reason : abortError('request aborted')
    controller.abort(error)
    rejectAbort(error)
  }
  const parents = parentSignals.filter(isAbortSignal)
  for (const parent of parents) {
    if (parent.aborted) {
      onParentAbort?.(parent)
      abort(parent.reason ?? abortError('request aborted'))
      break
    }
    const listener = () => {
      onParentAbort?.(parent)
      abort(parent.reason ?? abortError('request aborted'))
    }
    parent.addEventListener('abort', listener, { once: true })
    listeners.push([parent, listener])
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      onTimeout?.()
      abort(abortError('request timed out', 'TimeoutError'))
    }, finiteTimeout(timeoutMs))
  }
  return {
    controller,
    signal: controller.signal,
    aborted,
    abort,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      for (const [parent, listener] of listeners) parent.removeEventListener('abort', listener)
    },
  }
}

async function runWithTimeout(task, parentSignals = [], timeoutMs) {
  const scope = createAbortScope(parentSignals, timeoutMs)
  const taskPromise = scope.signal.aborted
    ? Promise.reject(scope.signal.reason ?? abortError('request aborted'))
    : Promise.resolve().then(() => task(scope.signal))
  try {
    return await Promise.race([taskPromise, scope.aborted])
  } finally {
    scope.dispose()
  }
}

async function fetchWithTimeout(fetchImpl, url, options, parentSignal, timeoutMs) {
  const requestOptions = options ?? {}
  return runWithTimeout(
    signal => fetchImpl(url, { ...requestOptions, signal }),
    [parentSignal, requestOptions.signal],
    timeoutMs,
  )
}

const refreshFlights = new WeakMap()
const sessionMutations = new Map()

function canonicalSessionPath(path) {
  return resolvePath(path)
}

function mutationState(path) {
  let state = sessionMutations.get(path)
  if (state === undefined) {
    state = {
      tail: Promise.resolve(),
      generation: 0,
      pendingMutations: 0,
      activeRefreshes: 0,
      holders: 0,
    }
    sessionMutations.set(path, state)
  }
  return state
}

function maybeCleanupMutationState(path, state) {
  if (
    state.pendingMutations === 0
    && state.activeRefreshes === 0
    && state.holders === 0
    && sessionMutations.get(path) === state
  ) sessionMutations.delete(path)
}

function retainMutationState(path) {
  const state = mutationState(path)
  state.holders += 1
  return state
}

function releaseMutationState(path, state) {
  state.holders -= 1
  maybeCleanupMutationState(path, state)
}

function invalidateSession(path) {
  const state = mutationState(path)
  state.generation += 1
  return state.generation
}

function enqueueSessionMutation(path, operation) {
  const state = mutationState(path)
  state.pendingMutations += 1
  const run = state.tail.catch(() => {}).then(operation)
  state.tail = run.catch(() => {}).finally(() => {
    state.pendingMutations -= 1
    maybeCleanupMutationState(path, state)
  })
  return run
}

function runtimeRefreshFlights(runtime) {
  let flights = refreshFlights.get(runtime)
  if (flights === undefined) {
    flights = new Map()
    refreshFlights.set(runtime, flights)
  }
  return flights
}

function runtimePathRefreshFlights(runtime, path) {
  const flights = runtimeRefreshFlights(runtime)
  let byIdentity = flights.get(path)
  if (byIdentity === undefined) {
    byIdentity = new Map()
    flights.set(path, byIdentity)
  }
  return byIdentity
}

async function commitSessionWrite(path, generation, session, expectedRefreshToken, isCurrent = () => true) {
  return enqueueSessionMutation(path, async () => {
    const state = mutationState(path)
    const current = await readSession(path)
    const signedOut = await hasSignOutTombstone(path)
    if (state.generation !== generation || !isCurrent() || signedOut) return false
    if (
      expectedRefreshToken !== undefined
      && current !== undefined
      && current.refreshToken !== expectedRefreshToken
    ) return false
    await writeSession(path, session)
    return true
  })
}

async function commitSessionDelete(path, generation, expectedRefreshToken) {
  return enqueueSessionMutation(path, async () => {
    const state = mutationState(path)
    const current = await readSession(path)
    if (state.generation !== generation) return false
    if (expectedRefreshToken !== undefined && current?.refreshToken !== expectedRefreshToken) return false
    await deleteSession(path)
    return true
  })
}

async function commitSignOutTombstoneDelete(path, generation) {
  return enqueueSessionMutation(path, async () => {
    const state = mutationState(path)
    if (state.generation !== generation) return false
    await deleteSignOutTombstone(path)
    return true
  })
}

async function commitLogout(path, generation) {
  return enqueueSessionMutation(path, async () => {
    const state = mutationState(path)
    if (state.generation !== generation) return false
    await writeSignOutTombstone(path)
    await deleteSession(path)
    return true
  })
}

function sameSessionIdentity(current, previous, candidate) {
  if (current === undefined) return false
  const sameSession = current.accessToken === candidate.accessToken
    && current.refreshToken === candidate.refreshToken
    && current.expiresAt === candidate.expiresAt
    && current.email === candidate.email
    && current.userId === candidate.userId
  if (sameSession) return true
  const updated = current.accessToken !== previous.accessToken
    || current.refreshToken !== previous.refreshToken
    || current.expiresAt !== previous.expiresAt
    || current.email !== previous.email
    || current.userId !== previous.userId
  if (!updated) return false
  if (current.refreshToken !== previous.refreshToken) return true
  if (current.refreshToken === candidate.refreshToken) return true
  const userId = candidate.userId ?? previous.userId
  if (userId !== undefined && current.userId === userId) return true
  const email = candidate.email ?? previous.email
  return email !== undefined && current.email === email
}

export function buildDeviceCodeBody({ clientId, scope }) {
  return new URLSearchParams({
    client_id: clientId,
    scope,
  })
}

export function buildTokenBody({ clientId, deviceCode }) {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: clientId,
  })
}

export function buildRefreshBody({ clientId, refreshToken }) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
}

export function parseDeviceCodeResponse(value, options = {}) {
  if (!isRecord(value)) return undefined
  const optionRecord = isRecord(options) ? options : {}
  const issuer = typeof options === 'string' ? options : optionRecord.issuer ?? OAUTH_ISSUER
  const context = issuerContext(issuer)
  if (context === undefined) return undefined
  const deviceCode = readString(value, 'device_code')
  const userCode = readString(value, 'user_code')
  const verificationUrl = trustedHttpsUrl(readString(value, 'verification_uri'), context)
  const completeValue = readString(value, 'verification_uri_complete') ?? verificationUrl
  const verificationUrlComplete = trustedHttpsUrl(completeValue, context)
  if (deviceCode === undefined || userCode === undefined || verificationUrl === undefined || verificationUrlComplete === undefined) {
    return undefined
  }
  const expiresIn = typeof value.expires_in === 'number' && value.expires_in > 0 ? value.expires_in : 600
  const interval = typeof value.interval === 'number' && value.interval > 0 ? value.interval : 5
  return { deviceCode, userCode, verificationUrl, verificationUrlComplete, expiresIn, interval }
}

function decodeJwtPayload(token) {
  const parts = token.split('.')
  const payload = parts[1]
  if (payload === undefined) return undefined
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const value = JSON.parse(json)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function parseTokenResponse(body, now, previous) {
  if (!isRecord(body)) return undefined
  const accessToken = readString(body, 'access_token')
  const refreshToken = readString(body, 'refresh_token') ?? previous?.refreshToken
  if (accessToken === undefined || refreshToken === undefined) return undefined
  let expiresAt
  if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0) {
    expiresAt = new Date(now + body.expires_in * 1000).toISOString()
  } else {
    const exp = decodeJwtPayload(accessToken)?.exp
    expiresAt = typeof exp === 'number' ? new Date(exp * 1000).toISOString() : new Date(now).toISOString()
  }
  const idClaims = readString(body, 'id_token') === undefined ? undefined : decodeJwtPayload(body.id_token)
  const email = (idClaims === undefined ? undefined : readString(idClaims, 'email')) ?? previous?.email
  const userId = (idClaims === undefined ? undefined : readString(idClaims, 'sub')) ?? previous?.userId
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt,
    ...email === undefined ? {} : { email },
    ...userId === undefined ? {} : { userId },
  }
}

export async function discoverEndpoints(issuer, fetchImpl = fetch, options, requestOptions = {}) {
  const context = issuerContext(issuer)
  if (context === undefined) throw new Error('invalid OAuth issuer')
  const request = isRecord(requestOptions) ? requestOptions : {}
  const fallback = {
    deviceAuthorizationEndpoint: joinUrl(context.issuer, DEVICE_CODE_PATH),
    tokenEndpoint: joinUrl(context.issuer, TOKEN_PATH),
    userinfoEndpoint: joinUrl(context.issuer, USERINFO_PATH),
  }
  try {
    const response = await fetchWithTimeout(fetchImpl, joinUrl(context.issuer, OPENID_CONFIG_PATH), {
      headers: { accept: 'application/json' },
      redirect: 'error',
    }, readSignal(request), request.timeoutMs)
    if (!response.ok) return fallback
    const body = await readJson(response, readSignal(request), request.timeoutMs)
    if (!isRecord(body)) return fallback
    const discoveredIssuer = readString(body, 'issuer')
    if (discoveredIssuer !== context.issuer) return fallback
    const deviceAuthorizationEndpoint = trustedHttpsUrl(
      readString(body, 'device_authorization_endpoint'),
      context,
    )
    const tokenEndpoint = trustedHttpsUrl(readString(body, 'token_endpoint'), context)
    const userinfoEndpoint = trustedHttpsUrl(readString(body, 'userinfo_endpoint'), context)
    return {
      deviceAuthorizationEndpoint: deviceAuthorizationEndpoint ?? fallback.deviceAuthorizationEndpoint,
      tokenEndpoint: tokenEndpoint ?? fallback.tokenEndpoint,
      userinfoEndpoint: userinfoEndpoint ?? fallback.userinfoEndpoint,
    }
  } catch {
    return fallback
  }
}

async function readJson(response, parentSignal, timeoutMs) {
  try {
    return await runWithTimeout(() => response.json(), [parentSignal], timeoutMs)
  } catch {
    return undefined
  }
}

async function enrichUserinfo(session, userinfoEndpoint, fetchImpl, requestOptions = {}) {
  if (session.email !== undefined && session.userId !== undefined) return session
  const request = isRecord(requestOptions) ? requestOptions : {}
  const signal = readSignal(request)
  try {
    const response = await fetchWithTimeout(fetchImpl, userinfoEndpoint, {
      headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
      redirect: 'error',
    }, signal, request.timeoutMs)
    if (!response.ok) return session
    const body = await readJson(response, signal, request.timeoutMs)
    if (!isRecord(body)) return session
    return {
      ...session,
      email: session.email ?? readString(body, 'email'),
      userId: session.userId ?? readString(body, 'sub'),
    }
  } catch {
    return session
  }
}

export function createAuthRuntime(overrides) {
  return {
    issuer: OAUTH_ISSUER,
    clientId: OAUTH_CLIENT_ID,
    scope: OAUTH_SCOPE,
    fetch: fetch,
    now: () => Date.now(),
    timeoutMs: LOGIN_TIMEOUT_MS,
    requestTimeoutMs: undefined,
    refreshSkewMs: REFRESH_SKEW_MS,
    openBrowser: async () => undefined,
    grokCliAuthPath: undefined,
    allowedOrigins: undefined,
    ...overrides,
  }
}

export async function refreshSession(runtime, session, options) {
  const result = await refreshSessionResult(runtime, session, readSignal(options))
  return result.session
}

async function refreshSessionResult(runtime, session, signal) {
  const timeoutMs = requestTimeoutMs(runtime)
  let endpoints
  try {
    endpoints = await discoverEndpoints(runtime.issuer, runtime.fetch, runtime.allowedOrigins, {
      signal,
      timeoutMs,
    })
  } catch {
    return { session: undefined, invalidGrant: false }
  }
  let response
  try {
    response = await fetchWithTimeout(runtime.fetch, endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: buildRefreshBody({ clientId: runtime.clientId, refreshToken: session.refreshToken }),
      redirect: 'error',
    }, signal, timeoutMs)
  } catch {
    return { session: undefined, invalidGrant: false }
  }
  const body = await readJson(response, signal, timeoutMs)
  const serverError = typeof response.status === 'number' && response.status >= 500
  const invalidGrant = !serverError && isRecord(body) && readString(body, 'error') === 'invalid_grant'
  if (invalidGrant || !response.ok) {
    return {
      session: undefined,
      invalidGrant,
    }
  }
  const parsed = parseTokenResponse(body, runtime.now(), session)
  if (parsed === undefined) return { session: undefined, invalidGrant: false }
  return {
    session: await enrichUserinfo(parsed, endpoints.userinfoEndpoint, runtime.fetch, {
      signal,
      timeoutMs,
    }),
    invalidGrant: false,
  }
}

async function loadSessionAt(runtime, path, state, generation) {
  if (await hasSignOutTombstone(path)) return undefined
  if (state.generation !== generation) return undefined
  const stored = await readSession(path)
  if (state.generation !== generation) return undefined
  if (stored !== undefined) return stored
  if (await hasSignOutTombstone(path)) return undefined
  if (state.generation !== generation) return undefined
  const imported = await readGrokCliSession(runtime.grokCliAuthPath)
  if (imported === undefined) return undefined
  const committed = await commitSessionWrite(path, generation, imported)
  if (committed) return imported
  if (state.generation !== generation) return undefined
  return readSession(path)
}

export async function loadSession(runtime) {
  const path = canonicalSessionPath(runtime.resolveSessionPath())
  const state = retainMutationState(path)
  const generation = state.generation
  try {
    return await loadSessionAt(runtime, path, state, generation)
  } finally {
    releaseMutationState(path, state)
  }
}

export async function ensureFreshSession(runtime, options) {
  const signal = readSignal(options)
  const path = canonicalSessionPath(runtime.resolveSessionPath())
  const state = retainMutationState(path)
  const generation = state.generation
  try {
    const session = await loadSessionAt(runtime, path, state, generation)
    if (session === undefined) return undefined
    if (state.generation !== generation) return undefined
    if (!sessionNeedsRefresh(session, runtime.now(), runtime.refreshSkewMs)) return session
    const flights = runtimePathRefreshFlights(runtime, path)
    const identity = session.refreshToken
    const inFlight = flights.get(identity)
    if (inFlight !== undefined) return inFlight
    state.activeRefreshes += 1
    const flight = (async () => {
      const result = await refreshSessionResult(runtime, session, signal)
      if (result.session === undefined) {
        if (result.invalidGrant) await commitSessionDelete(path, generation, identity)
        return undefined
      }
      const committed = await commitSessionWrite(path, generation, result.session, identity)
      if (committed && state.generation === generation) return result.session
      const current = await readSession(path)
      return sameSessionIdentity(current, session, result.session) ? current : undefined
    })()
    flights.set(identity, flight)
    try {
      return await flight
    } finally {
      if (flights.get(identity) === flight) flights.delete(identity)
      if (flights.size === 0) runtimeRefreshFlights(runtime).delete(path)
      state.activeRefreshes -= 1
      maybeCleanupMutationState(path, state)
    }
  } finally {
    releaseMutationState(path, state)
  }
}

export function statusFromSession(session) {
  if (session === undefined) return { kind: 'signed-out' }
  return {
    kind: 'signed-in',
    ...session.email === undefined ? {} : { email: session.email },
  }
}

/**
 * Device-code login controller. One in-flight login per runtime.
 */
export function createLoginController(runtime) {
  const path = canonicalSessionPath(runtime.resolveSessionPath())
  let pending
  let pollAbort
  let authError
  let activeFlow

  const releaseFlow = (flow) => {
    if (flow.released) return
    flow.released = true
    if (activeFlow === flow) activeFlow = undefined
    if (pollAbort?.signal === flow.signal) pollAbort = undefined
    flow.dispose()
    releaseMutationState(path, flow.state)
  }

  const status = async (options) => {
    if (pending !== undefined) {
      return {
        kind: 'pending',
        userCode: pending.userCode,
        verificationUrl: pending.verificationUrlComplete,
      }
    }
    if (authError !== undefined) return { kind: 'error', message: authError }
    const session = await ensureFreshSession(runtime, { signal: readSignal(options) })
    return statusFromSession(session)
  }

  const cancel = async () => {
    if (activeFlow !== undefined) {
      activeFlow.cancelled = true
      activeFlow.abort(abortError('login cancelled'))
    }
    pollAbort?.abort()
    pollAbort = undefined
    pending = undefined
    authError = undefined
    return { ok: true }
  }

  const logout = async () => {
    await cancel()
    const generation = invalidateSession(path)
    await commitLogout(path, generation)
    return { ok: true }
  }

  const start = async (options) => {
    await cancel()
    const parentSignal = readSignal(options)
    const state = retainMutationState(path)
    const generation = invalidateSession(path)
    const flow = {
      state,
      generation,
      released: false,
      cancelled: false,
      timedOut: false,
      parentAborted: false,
    }
    const scope = createAbortScope(
      [parentSignal],
      runtime.timeoutMs,
      () => { flow.timedOut = true },
      () => { flow.parentAborted = true },
    )
    flow.signal = scope.signal
    flow.abort = scope.abort
    flow.dispose = scope.dispose
    activeFlow = flow
    pollAbort = scope.controller
    let polling = false
    const currentGeneration = () => state.generation === generation
    const startError = (fallback) => {
      pending = undefined
      if (flow.cancelled || flow.parentAborted || !currentGeneration()) {
        return { kind: 'error', message: 'xAI device authorization cancelled.' }
      }
      const message = flow.timedOut ? 'xAI device authorization timed out.' : fallback
      authError = message
      return { kind: 'error', message }
    }
    try {
      if (flow.signal.aborted) return startError('xAI device authorization failed.')
      if (!await commitSignOutTombstoneDelete(path, generation)) {
        return startError('xAI device authorization cancelled.')
      }
      let endpoints
      let response
      try {
        const timeoutMs = requestTimeoutMs(runtime)
        endpoints = await discoverEndpoints(runtime.issuer, runtime.fetch, runtime.allowedOrigins, {
          signal: flow.signal,
          timeoutMs,
        })
        response = await fetchWithTimeout(runtime.fetch, endpoints.deviceAuthorizationEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: buildDeviceCodeBody({ clientId: runtime.clientId, scope: runtime.scope }),
          redirect: 'error',
        }, flow.signal, timeoutMs)
      } catch {
        return startError('xAI device authorization failed.')
      }
      if (flow.signal.aborted || !currentGeneration()) return startError('xAI device authorization cancelled.')
      const device = parseDeviceCodeResponse(await readJson(response, flow.signal, requestTimeoutMs(runtime)), {
        issuer: runtime.issuer,
        allowedOrigins: runtime.allowedOrigins,
      })
      if (device === undefined) {
        return startError('xAI did not return a valid device authorization URL.')
      }
      if (flow.signal.aborted || !currentGeneration()) return startError('xAI device authorization cancelled.')
      pending = device
      try {
        await runWithTimeout(
          () => runtime.openBrowser(device.verificationUrlComplete, {
            allowedOrigins: runtime.allowedOrigins,
          }),
          [flow.signal],
          requestTimeoutMs(runtime),
        )
      } catch {
        // The user can still open the URL from the settings page.
      }
      if (flow.signal.aborted || pollAbort?.signal !== flow.signal || !currentGeneration()) {
        return startError('xAI device authorization cancelled.')
      }
      polling = true
      void pollForToken({ runtime, endpoints, device, signal: flow.signal }).then(async (session) => {
        const currentFlow = !flow.cancelled
          && pollAbort?.signal === flow.signal
          && currentGeneration()
        if (flow.signal.aborted || !currentFlow) {
          if (currentFlow) {
            pending = undefined
            pollAbort = undefined
            authError = flow.timedOut
              ? 'xAI device authorization timed out.'
              : flow.parentAborted
                ? 'xAI device authorization cancelled.'
                : 'xAI device authorization failed.'
          }
          return
        }
        if (session !== undefined) {
          const committed = await commitSessionWrite(
            path,
            generation,
            session,
            undefined,
            () => !flow.cancelled && pollAbort?.signal === flow.signal && currentGeneration(),
          )
          if (!committed) {
            if (!flow.cancelled && pollAbort?.signal === flow.signal && currentGeneration()) {
              pending = undefined
              pollAbort = undefined
            }
            return
          }
          if (flow.cancelled || pollAbort?.signal !== flow.signal || !currentGeneration()) return
          authError = undefined
        } else {
          authError = 'xAI device authorization timed out.'
        }
        pending = undefined
        pollAbort = undefined
      }).catch((error) => {
        if (
          flow.cancelled
          || flow.signal.aborted
          || pollAbort?.signal !== flow.signal
          || !currentGeneration()
        ) return
        authError = error instanceof Error
          && (error.message === 'xAI device authorization was denied.'
            || error.message === 'xAI device authorization failed.')
          ? error.message
          : 'xAI device authorization failed.'
        pending = undefined
        pollAbort = undefined
      }).finally(() => releaseFlow(flow))
      return {
        kind: 'pending',
        userCode: device.userCode,
        verificationUrl: device.verificationUrlComplete,
      }
    } finally {
      if (!polling) releaseFlow(flow)
    }
  }

  return { start, status, cancel, logout }
}

async function pollForToken({ runtime, endpoints, device, signal }) {
  const deadline = runtime.now() + Math.min(device.expiresIn * 1000, runtime.timeoutMs)
  let interval = (device.interval > 0 ? device.interval : DEFAULT_POLL_INTERVAL_MS / 1000) * 1000
  while (runtime.now() < deadline) {
    if (signal.aborted) return undefined
    await sleep(Math.min(interval, deadline - runtime.now()), signal)
    if (signal.aborted) return undefined
    let response
    try {
      const timeoutMs = requestTimeoutMs(runtime)
      response = await fetchWithTimeout(runtime.fetch, endpoints.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: buildTokenBody({ clientId: runtime.clientId, deviceCode: device.deviceCode }),
        redirect: 'error',
      }, signal, timeoutMs)
    } catch (error) {
      if (signal.aborted) return undefined
      throw new Error('xAI device authorization failed.', { cause: error })
    }
    const body = await readJson(response, signal, requestTimeoutMs(runtime))
    if (response.ok) {
      const parsed = parseTokenResponse(body, runtime.now())
      if (parsed === undefined) throw new Error('xAI device authorization failed.')
      return enrichUserinfo(parsed, endpoints.userinfoEndpoint, runtime.fetch, {
        signal,
        timeoutMs: requestTimeoutMs(runtime),
      })
    }
    const error = isRecord(body) ? readString(body, 'error') : undefined
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += 1000
      continue
    }
    if (error === 'access_denied') throw new Error('xAI device authorization was denied.')
    throw new Error('xAI device authorization failed.')
  }
  return undefined
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reject
  })
}
