import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolkitRuntime } from '../src/runtime.ts'
import { createLoopbackFetch, normalizeBaseURL, parseModels } from '../src/http.ts'
import { defaultSettings, PROVIDER_ID, type ModelSelection } from '../src/shared.ts'
import { ConfigStore, validateSettings } from '../src/config.ts'
import { DiscoveryError, type CredentialRequest, type DiscoveredConnection } from '../src/discovery.ts'
import { readSharedCredential, type CredentialSourceResult } from '../src/credential-session.ts'

const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f() })
async function directory() { const value = await mkdtemp(join(tmpdir(), 'dsh-toolkit-test-')); cleanup.push(() => rm(value, { recursive: true, force: true })); return value }
async function gateway() {
  const fixture = { ids: ['workbuddy/glm-test', 'qoder/glm-test', 'glm-test', 'traework/__proto__'], key: 'fixture-not-a-real-key', status: 200, calls: 0, health: 0, delay: 0, auths: [] as string[] }
  const server = createServer(async (req, res) => {
    if (req.url === '/health') { fixture.health++; res.setHeader('content-type', 'application/json'); res.end('{"status":"ok"}'); return }
    fixture.calls++
    fixture.auths.push(req.headers.authorization ?? '')
    if (fixture.delay) await new Promise(resolve => setTimeout(resolve, fixture.delay))
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== 'Bearer ' + fixture.key) { res.writeHead(401); res.end('{"error":{"code":"invalid_api_key"}}'); return }
    res.writeHead(fixture.status)
    res.end(JSON.stringify({ object: 'list', data: fixture.ids.map(id => ({ id, object: 'model', owned_by: id.includes('/') ? id.split('/')[0] : 'auto' })) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const port = (server.address() as { port: number }).port
  return { fixture, server, baseURL: 'http://127.0.0.1:' + port + '/v1' }
}
function selection(): ModelSelection {
  let current: { provider: string; model: string } | undefined = { provider: 'other', model: 'keep-existing' }
  return { current: () => current, available: () => true, save: vi.fn(async model => { current = { provider: PROVIDER_ID, model } }) }
}
async function runtime(discovery: () => Promise<DiscoveredConnection>, chosen = selection(), dir?: string) {
  const value = new ToolkitRuntime({ directory: dir ?? await directory(), discover: discovery, selection: chosen })
  cleanup.push(() => value.dispose())
  await value.start()
  return value
}
function sharedDiscovery(baseURL: string, source: () => Promise<CredentialSourceResult>) {
  const scope = randomUUID()
  return vi.fn(async (request: CredentialRequest = {}): Promise<DiscoveredConnection> => {
    const result = await readSharedCredential(scope, source, { retry: request.retry, rejectedGeneration: request.rejectedCredential?.generation })
    if (!result.ok) throw new DiscoveryError(result.code, result.message)
    return { baseURL, apiKey: result.key, credential: { scope, generation: result.generation, fresh: result.fresh } }
  })
}

describe('proxy boundary', () => {
  it('normalizes local roots but rejects remote addresses and embedded credentials', () => {
    expect(normalizeBaseURL('http://localhost:17860/')).toBe('http://127.0.0.1:17860/v1')
    expect(normalizeBaseURL('http://[::1]:17860/v1')).toBe('http://[::1]:17860/v1')
    for (const url of ['https://example.com/v1', 'http://127.0.0.1.evil.test/v1', 'http://key@127.0.0.1/v1', 'file:///tmp/key', 'http://127.0.0.1/v1?key=x']) expect(() => normalizeBaseURL(url)).toThrow()
  })
  it('rejects other origins and forces redirect:error', async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    const guarded = createLoopbackFetch('http://127.0.0.1:17860/v1', transport as typeof fetch)
    await expect(guarded('http://127.0.0.1:17861/v1/models')).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
    await guarded('http://127.0.0.1:17860/v1/models', { redirect: 'follow' })
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' })
  })
  it('keeps all exact platform IDs, automatic aliases and prototype-named IDs', () => {
    const ids = ['workbuddy/same', 'qoder/same', 'same', '__proto__', 'constructor']
    expect(parseModels({ data: ids.map(id => ({ id })) }).map(m => m.id)).toEqual(ids)
    expect(() => parseModels({ data: [{ id: 'valid' }, { id: '' }] })).toThrow()
    expect(parseModels({ data: [] })).toEqual([])
  })
  it('keeps positive catalog capacities without turning a context window into an output limit', () => {
    expect(parseModels({ data: [{ id: 'minimax-code/MiniMax-M3', context_window: 1_000_000, max_output_tokens: null }] })[0])
      .toEqual({ id: 'minimax-code/MiniMax-M3', name: 'minimax-code/MiniMax-M3', source: 'unknown', contextWindow: 1_000_000 })
    expect(parseModels({ data: [{ id: 'qoder/x', context_window: 1_000_000, max_output_tokens: 32768 }] })[0])
      .toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 32768 })
    for (const invalid of [0, -1, 1.5, '1000000', Number.MAX_SAFE_INTEGER + 1]) {
      const model = parseModels({ data: [{ id: 'x', context_window: invalid, max_output_tokens: invalid }] })[0]
      expect(model).not.toHaveProperty('contextWindow')
      expect(model).not.toHaveProperty('maxOutputTokens')
    }
  })
})

describe('automatic runtime', () => {
  it('shares one authorization across concurrently started and replaced plugin runtimes', async () => {
    const { fixture, baseURL } = await gateway()
    const source = vi.fn(async (): Promise<CredentialSourceResult> => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { ok: true, key: fixture.key }
    })
    const discovery = sharedDiscovery(baseURL, source)
    const [first, second] = await Promise.all([runtime(discovery), runtime(discovery)])
    expect(first.getState().status).toBe('connected')
    expect(second.getState().status).toBe('connected')
    first.dispose()
    const replacement = await runtime(discovery)
    expect(replacement.getState().status).toBe('connected')
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('does not reauthorize a freshly read but rejected key during first installation', async () => {
    const { fixture, baseURL } = await gateway()
    let key = 'stale-initial-source-key'
    const source = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key }))
    const discovery = sharedDiscovery(baseURL, source)
    const first = await runtime(discovery)
    expect(first.getState().status).toBe('unauthorized')
    const replacement = await runtime(discovery)
    await replacement.refresh(false)
    expect(replacement.getState().status).toBe('unauthorized')
    expect(source).toHaveBeenCalledTimes(1)
    key = fixture.key
    expect((await replacement.refresh()).status).toBe('connected')
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('does not reauthorize a late-starting runtime before the first credential generation is validated', async () => {
    let modelsCalls = 0
    let releaseFirst!: () => void
    let firstRequestSeen!: () => void
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstSeen = new Promise<void>(resolve => { firstRequestSeen = resolve })
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/health') { res.end('{"status":"ok"}'); return }
      modelsCalls++
      if (modelsCalls === 1) {
        firstRequestSeen()
        await firstResponse
      }
      res.writeHead(401)
      res.end('{"error":{"code":"invalid_api_key"}}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const source = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'stale-source-key-before-first-validation' }))
    const discovery = sharedDiscovery(baseURL, source)
    const first = new ToolkitRuntime({ directory: await directory(), discover: discovery, selection: selection() })
    cleanup.push(() => first.dispose())
    const starting = first.start()
    try {
      // The source read has finished, but its first HTTP validation is still pending.
      // A later instance receives a cached lease and must not interpret it as trusted.
      await firstSeen
      const second = await runtime(discovery)
      expect(second.getState().status).toBe('unauthorized')
      expect(source).toHaveBeenCalledTimes(1)
      expect(modelsCalls).toBe(2)
    } finally {
      releaseFirst()
      await starting
    }
    expect(first.getState().status).toBe('unauthorized')
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('preserves cancelled authorization across runtime replacement and retries only manually', async () => {
    const { fixture, baseURL } = await gateway()
    let granted = false
    const source = vi.fn(async (): Promise<CredentialSourceResult> => granted
      ? { ok: true, key: fixture.key }
      : { ok: false, code: 'credential-denied', message: '请允许系统授权。' })
    const discovery = sharedDiscovery(baseURL, source)
    expect((await runtime(discovery)).getState().status).toBe('credential-denied')
    const replacement = await runtime(discovery)
    await replacement.refresh(false)
    expect(source).toHaveBeenCalledTimes(1)
    granted = true
    expect((await replacement.refresh()).status).toBe('connected')
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('performs only one source reread when multiple runtimes observe the same rotated key', async () => {
    const { fixture, baseURL } = await gateway()
    const source = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: fixture.key }))
    const discovery = sharedDiscovery(baseURL, source)
    const [first, second] = await Promise.all([runtime(discovery), runtime(discovery)])
    fixture.key = 'rotated-shared-key'
    const states = await Promise.all([first.refresh(false), second.refresh(false)])
    expect(states.map(state => state.status)).toEqual(['connected', 'connected'])
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('connects without input, caches only in memory and never changes the default at startup', async () => {
    const { fixture, baseURL } = await gateway()
    const chosen = selection(), dir = await directory()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: fixture.key }))
    const value = await runtime(discovery, chosen, dir)
    expect(value.getState()).toMatchObject({ status: 'connected', selectedModelId: null, canSelect: true })
    expect(value.getState().models.map(m => m.id)).toEqual(fixture.ids)
    expect(JSON.stringify(value.getState())).not.toContain(fixture.key)
    expect(value.getState()).not.toHaveProperty('settings')
    expect(value.getState()).not.toHaveProperty('baseURL')
    expect(await readdir(dir)).toEqual([])
    await value.refresh(false)
    expect(discovery).toHaveBeenCalledTimes(1)
    expect(chosen.save).not.toHaveBeenCalled()
  })
  it('applies a dropdown selection to DSH and confirms the read-back', async () => {
    const { fixture, baseURL } = await gateway(), chosen = selection()
    const value = await runtime(async () => ({ baseURL, apiKey: fixture.key }), chosen)
    expect((await value.selectModel('qoder/glm-test')).selectedModelId).toBe('qoder/glm-test')
    expect(chosen.save).toHaveBeenCalledWith('qoder/glm-test')
    await expect(value.selectModel('not-in-catalog')).rejects.toThrow()
    expect(chosen.save).toHaveBeenCalledTimes(1)
  })
  it('rejects a missing host capability or a silent no-op instead of reporting success', async () => {
    const { fixture, baseURL } = await gateway(), chosen = selection()
    chosen.save = vi.fn(async () => {})
    const value = await runtime(async () => ({ baseURL, apiKey: fixture.key }), chosen)
    await expect(value.selectModel('glm-test')).rejects.toThrow('未保存')
    chosen.available = () => false
    expect(value.getState().canSelect).toBe(false)
    await expect(value.selectModel('glm-test')).rejects.toThrow('不支持')
  })
  it('keeps the actual DSH default visible when the model disappears from the proxy', async () => {
    const { fixture, baseURL } = await gateway()
    const value = await runtime(async () => ({ baseURL, apiKey: fixture.key }))
    await value.selectModel('qoder/glm-test')
    fixture.ids = ['workbuddy/glm-test']
    const state = await value.refresh(false)
    expect(state.selectedModelId).toBe('qoder/glm-test')
    expect(state.models.some(model => model.id === state.selectedModelId)).toBe(false)
  })
  it('rediscovers an absent/stopped proxy after it starts without manual credentials', async () => {
    const { fixture, baseURL } = await gateway()
    let present = false
    const value = await runtime(async () => {
      if (!present) throw new DiscoveryError('missing', '请下载 AI-Toolkit 并开启代理。')
      return { baseURL, apiKey: fixture.key }
    })
    expect(value.getState().status).toBe('missing')
    present = true
    expect((await value.refresh(false)).status).toBe('connected')
  })
  it('pauses denied credential access until an explicit dropdown retry', async () => {
    const { fixture, baseURL } = await gateway()
    let granted = false
    const discovery = vi.fn(async () => {
      if (!granted) throw new DiscoveryError('credential-denied', '请允许系统授权。')
      return { baseURL, apiKey: fixture.key }
    })
    const value = await runtime(discovery)
    expect(value.getState().status).toBe('credential-denied')
    await value.refresh(false); await value.refresh(false)
    expect(discovery).toHaveBeenCalledTimes(1)
    granted = true
    expect((await value.refresh()).status).toBe('connected')
    expect(discovery).toHaveBeenCalledTimes(2)
  })
  it('recovers a changed proxy key by rereading it once during catalog refresh', async () => {
    const { fixture, baseURL } = await gateway()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: fixture.key }))
    const value = await runtime(discovery)
    fixture.key = 'rotated-synthetic-key'
    expect((await value.refresh(false)).status).toBe('connected')
    expect(discovery).toHaveBeenCalledTimes(2)
    expect(await value.getApiKey(baseURL)).toBe(fixture.key)
    expect(JSON.stringify(value.getState())).not.toContain(fixture.key)
  })
  it('binds a newly discovered key to its new port, including already prepared requests', async () => {
    const one = await gateway(), two = await gateway()
    one.fixture.key = 'first-key'; two.fixture.key = 'second-key'
    let active = one
    const value = await runtime(async () => ({ baseURL: active.baseURL, apiKey: active.fixture.key }))
    active = two
    one.fixture.key = 'old-key-now-invalid'
    expect((await value.refresh()).status).toBe('connected')
    await expect(value.getApiKey(one.baseURL)).rejects.toThrow('地址已变更')
    expect(await value.getApiKey(two.baseURL)).toBe(two.fixture.key)
    expect(one.fixture.auths).not.toContain('Bearer second-key')
  })
  it('retains the cached catalog on failure, blocks inference, and replaces a valid empty catalog', async () => {
    const { fixture, baseURL } = await gateway()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: fixture.key }))
    const value = await runtime(discovery)
    const before = value.getState()
    fixture.status = 503
    expect((await value.refresh()).models).toEqual(before.models)
    expect(value.getState().canSelect).toBe(false)
    await expect(value.getApiKey()).rejects.toThrow()
    fixture.status = 200; fixture.ids = []
    expect((await value.refresh()).models).toEqual([])
    expect(discovery).toHaveBeenCalledTimes(1)
  })
  it('pauses credential rereads if the stored key remains unauthorized', async () => {
    const { fixture, baseURL } = await gateway()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: 'stale-key' }))
    const value = await runtime(discovery)
    expect(value.getState().status).toBe('unauthorized')
    await value.refresh(false); await value.refresh(false)
    expect(discovery).toHaveBeenCalledTimes(1)
    discovery.mockResolvedValue({ baseURL, apiKey: fixture.key })
    expect((await value.refresh()).status).toBe('connected')
  })
  it('checks port metadata without reading credentials again unless the port changes', async () => {
    const one = await gateway(), two = await gateway()
    one.fixture.key = 'one-key'; two.fixture.key = 'two-key'
    let active = one
    const discovery = vi.fn(async () => ({ baseURL: active.baseURL, apiKey: active.fixture.key }))
    const value = new ToolkitRuntime({ directory: await directory(), discover: discovery, resolveAddress: async () => active.baseURL, selection: selection() })
    cleanup.push(() => value.dispose())
    await value.start()
    await value.refresh(false)
    expect(discovery).toHaveBeenCalledTimes(1)
    active = two
    await value.refresh(false)
    expect(discovery).toHaveBeenCalledTimes(2)
    expect(one.fixture.auths).not.toContain('Bearer two-key')
    expect(await value.getApiKey(two.baseURL)).toBe('two-key')
  })
  it('does not reread credentials after a temporary metadata read failure', async () => {
    const { fixture, baseURL } = await gateway()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: fixture.key }))
    let readable = true
    const value = new ToolkitRuntime({ directory: await directory(), discover: discovery, resolveAddress: async () => {
      if (!readable) throw new DiscoveryError('offline', '暂时无法读取本地设置。')
      return baseURL
    }, selection: selection() })
    cleanup.push(() => value.dispose())
    await value.start()
    readable = false
    expect((await value.refresh(false)).status).toBe('offline')
    readable = true
    expect((await value.refresh(false)).status).toBe('connected')
    expect(discovery).toHaveBeenCalledTimes(1)
  })
  it('coalesces concurrent refreshes and does not repeat credential reads', async () => {
    const { fixture, baseURL } = await gateway()
    const discovery = vi.fn(async () => ({ baseURL, apiKey: fixture.key }))
    const value = await runtime(discovery)
    const calls = fixture.calls
    fixture.delay = 30
    await Promise.all([value.refresh(), value.refresh(), value.refresh()])
    expect(fixture.calls - calls).toBe(1)
    expect(discovery).toHaveBeenCalledTimes(1)
  })
  it('ignores saved v0.1 connection information and never writes a discovered key', async () => {
    const { fixture, baseURL } = await gateway(), dir = await directory()
    const store = new ConfigStore(dir)
    await store.save({ version: 1, settings: { ...defaultSettings(), baseURL: 'http://127.0.0.1:9/v1' }, models: [], lastSyncAt: null, rememberKey: true })
    const before = await readFile(join(dir, 'config.json'), 'utf8')
    const value = await runtime(async () => ({ baseURL, apiKey: fixture.key }), selection(), dir)
    expect(value.getSettings().baseURL).toBe(baseURL)
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(before)
  })
  it('round-trips declared catalog capacities in the legacy cache without adding missing limits', async () => {
    const store = new ConfigStore(await directory())
    const models = parseModels({ data: [{ id: 'minimax-code/MiniMax-M3', context_window: 1_000_000 }, { id: 'qoder/x', context_window: 1_000_000, max_output_tokens: 32768 }] })
    await store.save({ version: 1, settings: defaultSettings(), models, lastSyncAt: null })
    expect((await store.load()).models).toEqual(models)
  })
  it('does not follow a real redirect during discovery', async () => {
    const destination = await gateway()
    const server: Server = createServer((req, res) => {
      if (req.url === '/health') { res.end('{}'); return }
      res.writeHead(307, { location: destination.baseURL + '/models' }); res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const value = await runtime(async () => ({ baseURL: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', apiKey: 'fixture' }))
    expect(value.getState().status).toBe('offline')
    expect(destination.fixture.calls).toBe(0)
  })
})
