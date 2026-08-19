import {
  RPC_AUTH_CANCEL,
  RPC_AUTH_LOGOUT,
  RPC_AUTH_START,
  RPC_AUTH_STATUS,
} from './constants.js'

function internalError(message) {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
}

function requestSignal(payload, context) {
  for (const candidate of [context, context?.signal, payload, payload?.signal]) {
    if (isAbortSignal(candidate)) return candidate
  }
  return undefined
}

/**
 * Host RPC for the settings page. Tokens never appear in replies.
 *
 * The current RPC type does not require a cancellation context. If the
 * transport supplies one, forward its AbortSignal; OAuth also owns an
 * internal timeout so calls without a signal cannot remain pending forever.
 */
export function createGrokRpcHandler(controller) {
  return async (endpoint, payload, context) => {
    const signal = requestSignal(payload, context)
    const options = signal === undefined ? undefined : { signal }
    if (endpoint === RPC_AUTH_START) return { ok: true, value: await controller.start(options) }
    if (endpoint === RPC_AUTH_STATUS) return { ok: true, value: await controller.status(options) }
    if (endpoint === RPC_AUTH_LOGOUT) return { ok: true, value: await controller.logout(options) }
    if (endpoint === RPC_AUTH_CANCEL) return { ok: true, value: await controller.cancel(options) }
    return internalError(`unknown Grok endpoint: ${endpoint}`)
  }
}
