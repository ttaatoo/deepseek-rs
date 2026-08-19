import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { OAUTH_ISSUER } from './constants.js'

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Open an https URL in the system browser. */
export function browserLaunchSpec(url, os = platform(), _allowedOrigins) {
  if (typeof url !== 'string' || /[\u0000-\u001f\u007f]/u.test(url)) {
    throw new Error('refusing to open an invalid browser URL')
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('refusing to open an invalid browser URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('refusing to open a non-https url')
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('refusing to open a browser URL with credentials')
  }
  if (parsed.origin !== new URL(OAUTH_ISSUER).origin) {
    throw new Error('refusing to open an untrusted browser origin')
  }
  if (os === 'darwin') return { command: 'open', args: [parsed.href] }
  if (os === 'win32') return { command: 'explorer.exe', args: [parsed.href] }
  return { command: 'xdg-open', args: [parsed.href] }
}

export async function openSystemBrowser(url, options = {}) {
  const os = options.platform ?? platform()
  const spawnImpl = options.spawn ?? spawnDetached
  const spec = browserLaunchSpec(url, os, options.allowedOrigins)
  if (os === 'darwin' || os === 'win32') {
    await spawnImpl(spec.command, spec.args)
    return
  }
  try {
    await spawnImpl(spec.command, spec.args)
  } catch {
    await spawnImpl('sensible-open', spec.args)
  }
}
