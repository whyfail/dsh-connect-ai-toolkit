import { lstat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLoopbackFetch } from './http.js'

const CREDENTIAL_SERVICE = 'com.ai-toolkit.credits'
const GATEWAY_ACCOUNT = 'gateway-api-key'
const VAULT_ACCOUNT = 'vault'
const VAULT_PREFIX = 'ait-vault-v1:'
const CHUNK_PREFIX = 'ait-secret-v1:'
const MAX_CHUNKS = 128
const CHUNK_BYTES = 2000

export type DiscoveryErrorCode = 'missing' | 'offline' | 'credential-denied' | 'unsupported'

/** Only static messages cross into the UI; native errors can contain secret data. */
export class DiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode, message: string) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

export interface DiscoveredConnection { baseURL: string; apiKey: string }

export interface DiscoveryOptions {
  /** Test seam: production always uses the current OS user's home directory. */
  homeDirectory?: string
  platform?: NodeJS.Platform
  /** Reads exactly one requested record, never searches or enumerates credentials. */
  readSecret?: (account: string) => Promise<Uint8Array | null>
  /** Liveness only; the authenticated model request remains the model truth source. */
  probe?: (baseURL: string) => Promise<void>
}

async function optionalFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new DiscoveryError('offline', 'AI-Toolkit 数据文件路径不可安全读取。')
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError('offline', '无法只读访问 AI-Toolkit 数据文件。')
  }
}

async function dataDirectoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new DiscoveryError('offline', 'AI-Toolkit 数据目录不能是符号链接或其他非目录路径。')
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError('offline', '无法只读访问 AI-Toolkit 数据目录。')
  }
}

async function hasWalHeader(path: string): Promise<boolean> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    const header = Buffer.alloc(20)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
      throw new Error('Invalid SQLite header')
    }
    // SQLite's write/read format versions are at offsets 18 and 19.
    return header[18] === 2 || header[19] === 2
  } catch {
    throw new DiscoveryError('offline', '无法只读识别 AI-Toolkit 数据库格式。')
  } finally {
    await file?.close()
  }
}

async function readPort(homeDirectory: string): Promise<number> {
  const directory = join(homeDirectory, '.ai-toolkit')
  if (!await dataDirectoryExists(directory)) {
    throw new DiscoveryError('missing', '未找到 AI-Toolkit，请安装并开启本地代理。')
  }
  const path = join(directory, 'ai-toolkit.db')
  if (!await optionalFile(path)) throw new DiscoveryError('missing', '未找到 AI-Toolkit 数据库，请打开应用并开启本地代理。')
  const walHeader = await hasWalHeader(path)
  const wal = await optionalFile(`${path}-wal`)
  const shm = await optionalFile(`${path}-shm`)
  // SQLite can create a shared-memory sidecar even for read-only connections.
  // Reject an incomplete WAL setup instead of creating a missing sidecar.
  // Existing SHM indexes may be maintained by SQLite; readOnly/query_only
  // guarantee no SQL data writes, not immutable SHM bookkeeping bytes.
  // A cleanly closed WAL database can retain WAL header versions after both
  // sidecars disappear. Opening it read-only can still recreate those files.
  // These checks are not an atomic lock against the owning app changing modes.
  if ((wal || walHeader) && (!wal || !shm)) {
    throw new DiscoveryError('offline', 'AI-Toolkit 数据库正在更新，请稍后重试；插件不会修复或创建辅助文件。')
  }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250')
    const row = database.prepare('SELECT settings FROM credit_proxy_settings WHERE id=1').get()
    if (!row) return 17860
    if (typeof row.settings !== 'string') throw new Error('Invalid settings')
    const settings: unknown = JSON.parse(row.settings)
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings')
    const port = (settings as { port?: unknown }).port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid port')
    }
    return port
  } catch {
    throw new DiscoveryError('offline', '无法只读识别 AI-Toolkit 的代理端口，请确认版本与数据库状态。')
  } finally {
    database?.close()
  }
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new DiscoveryError('credential-denied', 'AI-Toolkit 代理凭据编码无效，请在 AI-Toolkit 中检查代理状态。') }
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value)) {
    throw new DiscoveryError('credential-denied', 'AI-Toolkit 代理凭据格式无效，请在 AI-Toolkit 中检查代理状态。')
  }
  return value
}

function validGeneration(value: string): boolean {
  const unwrapped = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value
  return /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i.test(unwrapped)
}

async function readChunked(read: NonNullable<DiscoveryOptions['readSecret']>): Promise<string | null> {
  const raw = await read(GATEWAY_ACCOUNT)
  if (raw === null) return null
  const header = decode(raw)
  if (!header.startsWith(CHUNK_PREFIX)) return validateKey(header)
  const parts = header.slice(CHUNK_PREFIX.length).split(':')
  const generation = parts[0] ?? ''
  const count = Number(parts[1])
  if (parts.length !== 2 || !validGeneration(generation) || !/^\+?\d+$/.test(parts[1] ?? '')
    || !Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) {
    throw new DiscoveryError('credential-denied', 'AI-Toolkit 代理凭据分块清单无效。')
  }
  const chunks: Uint8Array[] = []
  for (let index = 0; index < count; index++) {
    const chunk = await read(`${GATEWAY_ACCOUNT}/${generation}/${index}`)
    if (chunk === null || chunk.length > CHUNK_BYTES) {
      throw new DiscoveryError('credential-denied', 'AI-Toolkit 代理凭据分块不完整。')
    }
    chunks.push(chunk)
  }
  return validateKey(decode(Buffer.concat(chunks)))
}

async function nativeReader(platform: NodeJS.Platform): Promise<NonNullable<DiscoveryOptions['readSecret']>> {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return async account => {
      // withTarget is intentionally forbidden: its Windows constructor writes
      // a placeholder. The default constructor's user.service target matches
      // the keyring 3.6 backend used by AI-Toolkit, without modifying a record.
      // Source audit (including macOS's non-writing constructor):
      // THIRD_PARTY_NOTICES.md, "Read-only credential discovery audit".
      const entry = new AsyncEntry(CREDENTIAL_SERVICE, account,
        platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined)
      const bytes = await entry.getSecret(AbortSignal.timeout(30_000))
      return bytes === null ? null : Uint8Array.from(bytes)
    }
  } catch {
    throw new DiscoveryError('credential-denied', '系统凭据读取组件不可用，请检查本机运行环境。')
  }
}

async function readGatewayKey(platform: NodeJS.Platform, read: NonNullable<DiscoveryOptions['readSecret']>): Promise<string> {
  try {
    if (platform === 'darwin') {
      const raw = await read(VAULT_ACCOUNT)
      if (raw !== null) {
        const text = decode(raw)
        let vault: unknown
        try { vault = JSON.parse(text.startsWith(VAULT_PREFIX) ? text.slice(VAULT_PREFIX.length) : text) }
        catch { throw new DiscoveryError('credential-denied', 'AI-Toolkit 共享凭据格式无效。') }
        if (!vault || typeof vault !== 'object' || Array.isArray(vault)) {
          throw new DiscoveryError('credential-denied', 'AI-Toolkit 共享凭据格式无效。')
        }
        // The shared record contains other accounts. Never enumerate, return,
        // validate, or access any property except the proxy's own entry.
        const key = (vault as Record<string, unknown>)[GATEWAY_ACCOUNT]
        if (key !== undefined) return validateKey(key)
      }
    }
    const key = await readChunked(read)
    if (key === null) throw new DiscoveryError('missing', '尚未找到代理密钥，请在 AI-Toolkit 中开启一次本地代理。')
    return key
  } catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError('credential-denied', '无法读取 AI-Toolkit 代理密钥，请在系统授权弹窗中允许访问后重试。')
  }
}

async function probeHealth(baseURL: string): Promise<void> {
  try {
    const response = await createLoopbackFetch(baseURL)(new URL('/health', baseURL), { signal: AbortSignal.timeout(3_000) })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Gateway is not healthy')
  } catch {
    throw new DiscoveryError('offline', 'AI-Toolkit 本地代理未运行，请打开 AI-Toolkit 并开启代理。')
  }
}

/** Recheck only the persisted port; never probes HTTP or accesses credentials. */
export async function discoverBaseURL(options: Pick<DiscoveryOptions, 'homeDirectory'> = {}): Promise<string> {
  return `http://127.0.0.1:${await readPort(options.homeDirectory ?? homedir())}/v1`
}

/** Necessary local connection metadata and one proxy secret, always read-only. */
export async function discover(options: DiscoveryOptions = {}): Promise<DiscoveredConnection> {
  const platform = options.platform ?? process.platform
  if (!['darwin', 'win32', 'linux'].includes(platform)) {
    throw new DiscoveryError('unsupported', '当前系统暂不支持自动连接 AI-Toolkit。')
  }
  const baseURL = await discoverBaseURL(options)
  try { await (options.probe ?? probeHealth)(baseURL) }
  catch (error) {
    if (error instanceof DiscoveryError) throw error
    throw new DiscoveryError('offline', 'AI-Toolkit 本地代理未运行，请打开 AI-Toolkit 并开启代理。')
  }
  const read = options.readSecret ?? await nativeReader(platform)
  return { baseURL, apiKey: await readGatewayKey(platform, read) }
}
