import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discover, discoverBaseURL, DiscoveryError } from '../src/discovery.js'

const native = vi.hoisted(() => ({ construct: vi.fn(), read: vi.fn(), write: vi.fn(), explicitTarget: vi.fn() }))
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(service: string, private account: string, options?: unknown) { native.construct(service, account, options) }
    async getSecret() { return native.read(this.account) }
    async setSecret() { native.write(); throw new Error('Writes forbidden') }
    static withTarget() { native.explicitTarget(); throw new Error('Explicit target forbidden') }
  },
}))

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  native.construct.mockClear()
  native.read.mockReset()
  native.write.mockClear()
  native.explicitTarget.mockClear()
})

async function fixture(port: unknown = 19876): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), 'ai-toolkit-discovery-fixture-'))
  homes.push(home)
  const directory = join(home, '.ai-toolkit')
  await mkdir(directory)
  const path = join(directory, 'ai-toolkit.db')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE credit_proxy_settings(id INTEGER PRIMARY KEY,settings TEXT NOT NULL)')
  if (port !== null) database.prepare('INSERT INTO credit_proxy_settings VALUES(1,?)').run(JSON.stringify({ port }))
  database.close()
  return { home, path }
}

function secretReader(entries: Record<string, string | Uint8Array>) {
  return vi.fn(async (account: string) => {
    const value = entries[account]
    return value === undefined ? null : typeof value === 'string' ? Buffer.from(value) : value
  })
}
const probe = vi.fn(async (_baseURL: string) => {})

describe('read-only AI-Toolkit discovery', () => {
  it('rechecks only metadata without HTTP probes or credential reads', async () => {
    const { home } = await fixture(23457)
    const readSecret = secretReader({})
    const probeOnly = vi.fn(async () => {})
    const options = { homeDirectory: home, readSecret, probe: probeOnly }
    expect(await discoverBaseURL(options)).toBe('http://127.0.0.1:23457/v1')
    expect(probeOnly).not.toHaveBeenCalled()
    expect(readSecret).not.toHaveBeenCalled()
    expect(native.construct).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'win32'] as const)('uses only ordinary native construction and getSecret on %s', async platform => {
    const { home } = await fixture()
    const account = platform === 'darwin' ? 'vault' : 'gateway-api-key'
    native.read.mockImplementation(async (id: string) => id === account
      ? Array.from(Buffer.from(platform === 'darwin' ? JSON.stringify({ 'gateway-api-key': 'ait_synthetic_native' }) : 'ait_synthetic_native'))
      : null)
    expect((await discover({ homeDirectory: home, platform, probe })).apiKey).toBe('ait_synthetic_native')
    expect(native.construct.mock.calls).toEqual([['com.ai-toolkit.credits', account, undefined]])
    expect(native.read.mock.calls).toEqual([[account]])
    expect(native.write).not.toHaveBeenCalled()
    expect(native.explicitTarget).not.toHaveBeenCalled()
  })

  it('reads the configured port and only the gateway entry from the Mac shared vault', async () => {
    const { home, path } = await fixture()
    const before = await readFile(path)
    const entries = await readdir(join(home, '.ai-toolkit'))
    const readSecret = secretReader({ vault: 'ait-vault-v1:' + JSON.stringify({ 'gateway-api-key': 'ait_synthetic_proxy_key', 'platform-account': 'never-return-this-fixture' }) })
    expect(await discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).toEqual({ baseURL: 'http://127.0.0.1:19876/v1', apiKey: 'ait_synthetic_proxy_key' })
    expect(readSecret.mock.calls).toEqual([['vault']])
    expect(await readFile(path)).toEqual(before)
    expect(await readdir(join(home, '.ai-toolkit'))).toEqual(entries)
  })

  it('supports the unprefixed shared vault and the source default port when no row exists', async () => {
    const { home } = await fixture(null)
    const readSecret = secretReader({ vault: JSON.stringify({ 'gateway-api-key': 'ait_synthetic_default' }) })
    expect(await discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).toEqual({ baseURL: 'http://127.0.0.1:17860/v1', apiKey: 'ait_synthetic_default' })
  })

  it('reconstructs Windows raw UTF-8 secret chunks without reading a shared vault or other accounts', async () => {
    const { home } = await fixture()
    const generation = '2ba62309-a74a-4c43-83eb-19b6c3ac977f'
    const readSecret = secretReader({
      'gateway-api-key': `ait-secret-v1:${generation}:2`,
      [`gateway-api-key/${generation}/0`]: 'ait_synthetic_',
      [`gateway-api-key/${generation}/1`]: 'windows_proxy',
      unrelated: 'do-not-read',
    })
    expect((await discover({ homeDirectory: home, platform: 'win32', readSecret, probe })).apiKey).toBe('ait_synthetic_windows_proxy')
    expect(readSecret.mock.calls.map(call => call[0])).toEqual(['gateway-api-key', `gateway-api-key/${generation}/0`, `gateway-api-key/${generation}/1`])
  })

  it('reads a legacy Mac gateway record without migrating or writing it', async () => {
    const { home } = await fixture()
    const readSecret = secretReader({ 'gateway-api-key': 'ait_synthetic_legacy' })
    expect((await discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).apiKey).toBe('ait_synthetic_legacy')
    expect(readSecret.mock.calls).toEqual([['vault'], ['gateway-api-key']])
  })

  it('does not create a missing database and does not ask the keychain when the app is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ai-toolkit-absent-fixture-'))
    homes.push(home)
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'missing' })
    expect(await readdir(home)).toEqual([])
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('rejects a symlinked AI-Toolkit data directory before following it to a database', async () => {
    const { home: targetHome, path } = await fixture()
    const home = await mkdtemp(join(tmpdir(), 'ai-toolkit-linked-directory-fixture-'))
    homes.push(home)
    await symlink(join(targetHome, '.ai-toolkit'), join(home, '.ai-toolkit'), process.platform === 'win32' ? 'junction' : 'dir')
    const original = await readFile(path)
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'offline' })
    expect(readSecret).not.toHaveBeenCalled()
    expect(await readFile(path)).toEqual(original)
  })

  it('rejects a non-directory AI-Toolkit parent path without creating a database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ai-toolkit-invalid-directory-fixture-'))
    homes.push(home)
    await writeFile(join(home, '.ai-toolkit'), 'synthetic-file')
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'offline' })
    expect(await readFile(join(home, '.ai-toolkit'), 'utf8')).toBe('synthetic-file')
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('does not ask the credential store when the configured proxy is offline', async () => {
    const { home } = await fixture()
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe: async () => { throw new Error('offline') } })).rejects.toMatchObject({ code: 'offline' })
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('does not treat locked or denied credential access as missing, or expose the native error', async () => {
    const { home } = await fixture()
    const result = discover({ homeDirectory: home, platform: 'darwin', probe, readSecret: async () => { throw new Error('denied ait_private_fixture') } })
    await expect(result).rejects.toMatchObject({ code: 'credential-denied' })
    await expect(result).rejects.not.toThrow('ait_private_fixture')
  })

  it.each(['ait-secret-v1:invalid:1', 'ait-secret-v1:2ba62309-a74a-4c43-83eb-19b6c3ac977f:0', 'ait-secret-v1:2ba62309-a74a-4c43-83eb-19b6c3ac977f:129'])('rejects invalid manifests without enumerating credentials: %s', async manifest => {
    const { home } = await fixture()
    const readSecret = secretReader({ 'gateway-api-key': manifest })
    await expect(discover({ homeDirectory: home, platform: 'win32', readSecret, probe })).rejects.toMatchObject({ code: 'credential-denied' })
    expect(readSecret).toHaveBeenCalledTimes(1)
  })

  it.each(['ait_key\nmalformed', 'ait_key\u0000malformed', 'ait_key\tmalformed', ''])('refuses control characters and empty proxy keys', async key => {
    const { home } = await fixture()
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret: secretReader({ vault: JSON.stringify({ 'gateway-api-key': key }) }), probe })).rejects.toBeInstanceOf(DiscoveryError)
  })

  it('rejects oversized or missing chunks rather than trying unrelated credential names', async () => {
    const { home } = await fixture()
    const generation = '2ba62309-a74a-4c43-83eb-19b6c3ac977f'
    for (const value of [undefined, 'x'.repeat(2001)]) {
      const readSecret = secretReader({ 'gateway-api-key': `ait-secret-v1:${generation}:1`, ...(value === undefined ? {} : { [`gateway-api-key/${generation}/0`]: value }) })
      await expect(discover({ homeDirectory: home, platform: 'win32', readSecret, probe })).rejects.toMatchObject({ code: 'credential-denied' })
      expect(readSecret).toHaveBeenCalledTimes(2)
    }
  })

  it('refuses an active WAL without SHM rather than creating a sidecar', async () => {
    const { home, path } = await fixture()
    await writeFile(`${path}-wal`, 'synthetic-wal-marker')
    const before = await readdir(join(home, '.ai-toolkit'))
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'offline' })
    expect(await readdir(join(home, '.ai-toolkit'))).toEqual(before)
    expect(await readFile(`${path}-wal`, 'utf8')).toBe('synthetic-wal-marker')
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('does not recreate either sidecar for a closed database whose header retains WAL mode', async () => {
    const { home, path } = await fixture()
    const writer = new DatabaseSync(path)
    writer.exec('PRAGMA journal_mode=WAL')
    writer.close()
    const original = await readFile(path)
    expect(original[18]).toBe(2)
    expect(original[19]).toBe(2)
    const before = await readdir(join(home, '.ai-toolkit'))
    expect(before).toEqual(['ai-toolkit.db'])
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'offline' })
    expect(await readdir(join(home, '.ai-toolkit'))).toEqual(before)
    expect(await readFile(path)).toEqual(original)
    expect(readSecret).not.toHaveBeenCalled()
  })

  it('reads committed WAL changes without immutable mode or SQL data changes', async () => {
    const { home, path } = await fixture()
    const writer = new DatabaseSync(path)
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
      writer.prepare('UPDATE credit_proxy_settings SET settings=? WHERE id=1').run(JSON.stringify({ port: 23456 }))
      const mainBefore = await readFile(path)
      const walBefore = await readFile(`${path}-wal`)
      const readSecret = secretReader({ 'gateway-api-key': 'ait_synthetic_wal_key' })
      expect((await discover({ homeDirectory: home, platform: 'win32', readSecret, probe })).baseURL).toBe('http://127.0.0.1:23456/v1')
      expect(await readFile(path)).toEqual(mainBefore)
      expect(await readFile(`${path}-wal`)).toEqual(walBefore)
    } finally { writer.close() }
  })

  it.each([0, 65536, 1.5, '17860'])('rejects invalid persisted ports without reading credentials', async port => {
    const { home } = await fixture(port)
    const readSecret = secretReader({})
    await expect(discover({ homeDirectory: home, platform: 'darwin', readSecret, probe })).rejects.toMatchObject({ code: 'offline' })
    expect(readSecret).not.toHaveBeenCalled()
  })
})
