import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteSession,
  parseGrokCliAuth,
  parseSession,
  readSession,
  sessionNeedsRefresh,
  writeSession,
} from '../src/session.js'

const SAMPLE = {
  version: 1,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: '2026-08-19T08:00:00.000Z',
  email: 'user@example.com',
  userId: 'user-1',
}

test('parseSession rejects a missing access token', () => {
  assert.equal(parseSession({ refreshToken: 'r', expiresAt: SAMPLE.expiresAt }), undefined)
})

test('parseSession accepts a complete session object', () => {
  assert.deepEqual(parseSession(SAMPLE), SAMPLE)
})

test('sessionNeedsRefresh is true when expiry is inside the skew window', () => {
  const now = Date.parse('2026-08-19T07:59:30.000Z')
  assert.equal(sessionNeedsRefresh(SAMPLE, now, 60_000), true)
  assert.equal(sessionNeedsRefresh(SAMPLE, Date.parse('2026-08-19T07:00:00.000Z'), 60_000), false)
})

test('writeSession then readSession round-trips the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, SAMPLE)
  const raw = await readFile(path, 'utf8')
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['grok-oauth.json'])
  assert.doesNotMatch(raw, /refresh-token-should-not-leak-via-other-field/)
  assert.deepEqual(await readSession(path), SAMPLE)
  await deleteSession(path)
  assert.equal(await readSession(path), undefined)
})

test('parseGrokCliAuth reads the official CLI auth.json key', () => {
  const session = parseGrokCliAuth({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: 'cli-access',
      refresh_token: 'cli-refresh',
      expires_at: '2026-08-19T08:00:00.000Z',
      email: 'cli@example.com',
      user_id: 'cli-user',
    },
  }, 'https://auth.x.ai', 'b1a00492-073a-47ea-816f-4c329264a828')
  assert.deepEqual(session, {
    version: 1,
    accessToken: 'cli-access',
    refreshToken: 'cli-refresh',
    expiresAt: '2026-08-19T08:00:00.000Z',
    email: 'cli@example.com',
    userId: 'cli-user',
  })
})

test('parseGrokCliAuth ignores a different client id', () => {
  assert.equal(parseGrokCliAuth({
    'https://auth.x.ai::other-client': { key: 'x', refresh_token: 'y', expires_at: SAMPLE.expiresAt },
  }, 'https://auth.x.ai', 'b1a00492-073a-47ea-816f-4c329264a828'), undefined)
})

test('readSession returns undefined for a truncated file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeFile(path, '{', 'utf8')
  assert.equal(await readSession(path), undefined)
})

test('writeSession atomically replaces a symlink without writing through it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  const outside = join(dir, 'outside.json')
  await writeFile(outside, 'keep this file', 'utf8')
  await symlink(outside, path)

  await writeSession(path, SAMPLE)

  assert.equal(await readFile(outside, 'utf8'), 'keep this file')
  assert.equal((await lstat(path)).isSymbolicLink(), false)
  assert.deepEqual(await readSession(path), SAMPLE)
})

test('readSession rejects symlinks, non-regular files, and files without mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const symlinkPath = join(dir, 'symlink.json')
  const outside = join(dir, 'outside.json')
  await writeSession(outside, SAMPLE)
  await symlink(outside, symlinkPath)
  assert.equal(await readSession(symlinkPath), undefined)

  const directoryPath = join(dir, 'directory.json')
  await mkdir(directoryPath)
  assert.equal(await readSession(directoryPath), undefined)

  const modePath = join(dir, 'mode.json')
  await writeSession(modePath, SAMPLE)
  await chmod(modePath, 0o644)
  assert.equal(await readSession(modePath), undefined)
})

test('deleteSession surfaces a parent directory sync error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-grok-'))
  const path = join(dir, 'grok-oauth.json')
  await writeSession(path, SAMPLE)
  await chmod(dir, 0o300)
  try {
    await assert.rejects(deleteSession(path), error => error?.code === 'EACCES' || error?.code === 'EPERM')
  } finally {
    await chmod(dir, 0o700)
  }
})
