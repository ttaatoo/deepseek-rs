import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { GrokAdapter, defaultConnectionOptions, resolveGrokAccessToken } from './adapter.js'
import { openSystemBrowser } from './browser.js'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER,
  RPC_CHANNEL,
  SESSION_FILENAME,
  SETTINGS_NS,
} from './constants.js'
import { createAuthRuntime, createLoginController, ensureFreshSession } from './oauth.js'
import { createGrokRpcHandler } from './rpc.js'

/** @typedef {{
 *   number(): { min(value: number): { default(value: number): unknown } },
 *   object(shape: object): unknown,
 * }} SchemasteryStatic */

/** @type {SchemasteryStatic} */
const schema = z

/** @typedef {{
 *   deepEqualJson(a: unknown, b: unknown): boolean,
 *   installSettingsSection(ctx: unknown, ns: string, schema: unknown, config: unknown, options: object): void,
 *   settingsNamespace(value: string): string,
 * }} SettingsApi */

/** @type {SettingsApi} */
const settingsApi = { deepEqualJson, installSettingsSection, settingsNamespace }

export const name = 'llm-grok'
export const inject = ['llm']

const NS = settingsApi.settingsNamespace(SETTINGS_NS)

export const Config = schema.object({
  streamIdleTimeoutMs: schema.number().min(1000).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

function resolveHome() {
  const envHome = process.env.DSH_HOME
  if (envHome !== undefined && envHome.trim().length > 0) return envHome.trim()
  return join(homedir(), '.dsh')
}

export function apply(ctx, config) {
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const retryPolicy = resolveRetryPolicy(raw.retryPolicy, 'llm-grok: retryPolicy')
    lastRaw = raw
    lastGood = {
      ...defaultConnectionOptions(retryPolicy),
      streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    }
    return lastGood
  }
  options()

  const runtime = createAuthRuntime({
    resolveSessionPath: () => join(resolveHome(), SESSION_FILENAME),
    openBrowser: openSystemBrowser,
  })
  const login = createLoginController(runtime)
  const adapter = new GrokAdapter({
    options,
    resolveApiKey: signal => resolveGrokAccessToken(runtime, signal),
  })

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Grok', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy
    if (settingsApi.deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.rpc.handle(
      RPC_CHANNEL,
      createGrokRpcHandler(login),
      { authority: 'loopback' },
    )
  })

  settingsApi.installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })

  void ensureFreshSession(runtime).then((session) => {
    if (session !== undefined) {
      ctx.logger.info(`llm-grok: signed in as ${session.email ?? 'subscription account'}`)
    }
  }).catch((error) => {
    ctx.logger.warn(`llm-grok: session hydrate failed: ${error instanceof Error ? error.message : error}`)
  })
}
