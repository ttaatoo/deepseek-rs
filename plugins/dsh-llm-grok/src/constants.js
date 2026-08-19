/** Provider route. Distinct from the built-in `xai` API-key catalog route. */
export const PROVIDER = 'grok'

/** Settings namespace and plugin row id. */
export const SETTINGS_NS = 'llm-grok'

/** xAI OIDC issuer used by the official Grok CLI. */
export const OAUTH_ISSUER = 'https://auth.x.ai'

/** Public client id of the official Grok CLI (`grok login`). */
export const OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/**
 * Scopes the official Grok CLI requests.
 * `grok-cli:access` is required by cli-chat-proxy; `api:access` alone is rejected.
 */
export const OAUTH_SCOPE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
  'conversations:read',
  'conversations:write',
  'workspaces:read',
  'workspaces:write',
].join(' ')

/** Chat proxy used by the Grok CLI (subscription tokens, not console API keys). */
export const CHAT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'

/** Session file under `$DSH_HOME`. */
export const SESSION_FILENAME = 'grok-oauth.json'

/** Official Grok CLI auth file; reused when present, never deleted by this plugin. */
export const GROK_CLI_AUTH_FILENAME = 'auth.json'

export const DEVICE_CODE_PATH = '/oauth2/device/code'
export const TOKEN_PATH = '/oauth2/token'
export const USERINFO_PATH = '/oauth2/userinfo'
export const OPENID_CONFIG_PATH = '/.well-known/openid-configuration'

export const REFRESH_SKEW_MS = 60_000
export const LOGIN_TIMEOUT_MS = 300_000
export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const DEFAULT_CONTEXT_WINDOW = 500_000
export const DEFAULT_MAX_TOKENS = 32_768

/** cli-chat-proxy answers 426 if these are missing. */
export const GROK_CLI_CLIENT_VERSION = '1.0.5'
export const GROK_CLI_CLIENT_IDENTIFIER = 'grok-shell'

export const RPC_CHANNEL = '/grok'
export const RPC_AUTH_START = 'auth/start'
export const RPC_AUTH_STATUS = 'auth/status'
export const RPC_AUTH_LOGOUT = 'auth/logout'
export const RPC_AUTH_CANCEL = 'auth/cancel'

export const DEFAULT_MODELS = Object.freeze([
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    thinking: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    thinking: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    thinking: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: 'low',
  },
  {
    id: 'grok-build-0.1',
    name: 'Grok Build 0.1',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    thinking: false,
  },
])
