import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  GROK_CLI_AUTH_FILENAME,
  OAUTH_CLIENT_ID,
  OAUTH_ISSUER,
  REFRESH_SKEW_MS,
  SESSION_FILENAME,
} from './constants.js'

const SIGN_OUT_TOMBSTONE_SUFFIX = '.signed-out'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record, key) {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Parse this plugin's session file body. */
export function parseSession(value) {
  if (!isRecord(value)) return undefined
  const accessToken = readString(value, 'accessToken')
  const refreshToken = readString(value, 'refreshToken')
  const expiresAt = readString(value, 'expiresAt')
  if (accessToken === undefined || refreshToken === undefined || expiresAt === undefined) return undefined
  const email = readString(value, 'email')
  const userId = readString(value, 'userId')
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt,
    ...email === undefined ? {} : { email },
    ...userId === undefined ? {} : { userId },
  }
}

/** Parse `~/.grok/auth.json` for the Grok CLI public client. */
export function parseGrokCliAuth(value, issuer = OAUTH_ISSUER, clientId = OAUTH_CLIENT_ID) {
  if (!isRecord(value)) return undefined
  const entry = value[`${issuer}::${clientId}`]
  if (!isRecord(entry)) return undefined
  const accessToken = readString(entry, 'key')
  const refreshToken = readString(entry, 'refresh_token')
  const expiresAt = readString(entry, 'expires_at')
  if (accessToken === undefined || refreshToken === undefined || expiresAt === undefined) return undefined
  const email = readString(entry, 'email')
  const userId = readString(entry, 'user_id')
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt,
    ...email === undefined ? {} : { email },
    ...userId === undefined ? {} : { userId },
  }
}

export function sessionNeedsRefresh(session, now, skewMs = REFRESH_SKEW_MS) {
  const expires = Date.parse(session.expiresAt)
  if (!Number.isFinite(expires)) return true
  return expires - now <= skewMs
}

export function defaultSessionPath(dshHome) {
  return join(dshHome, SESSION_FILENAME)
}

export function defaultGrokCliAuthPath() {
  return join(homedir(), '.grok', GROK_CLI_AUTH_FILENAME)
}

export function signOutTombstonePath(path) {
  return join(dirname(path), `.${basename(path)}${SIGN_OUT_TOMBSTONE_SUFFIX}`)
}

export async function hasSignOutTombstone(path) {
  try {
    await lstat(signOutTombstonePath(path))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

export async function readSession(path) {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!isReadableSessionFile(metadata)) return undefined

  let handle
  let raw
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const current = await handle.stat()
    if (!isReadableSessionFile(current)) return undefined
    raw = await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'EFTYPE')) return undefined
    throw error
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
  try {
    return parseSession(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function isReadableSessionFile(metadata) {
  if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600) return false
  const uid = process.getuid?.()
  return uid === undefined || metadata.uid === uid
}

export async function readGrokCliSession(path = defaultGrokCliAuthPath()) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return parseGrokCliAuth(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export async function writeSession(path, session) {
  await writeAtomicFile(path, `${JSON.stringify({
    version: 1,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    ...session.email === undefined ? {} : { email: session.email },
    ...session.userId === undefined ? {} : { userId: session.userId },
  }, null, 2)}\n`)
}

export async function writeSignOutTombstone(path) {
  await writeAtomicFile(signOutTombstonePath(path), 'signed-out\n')
}

async function writeAtomicFile(path, body) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(body, { encoding: 'utf8' })
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await syncDirectory(directory)
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)
      || (process.platform === 'win32' && error?.code === 'EPERM')
    if (!unsupported) throw error
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

export async function deleteSession(path) {
  try {
    await rm(path, { force: true })
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
  try {
    await syncDirectory(dirname(path))
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error
  }
}

export async function deleteSignOutTombstone(path) {
  await deleteSession(signOutTombstonePath(path))
}
