import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_ROOT, defaultSettings } from '../src/shared.js'
import { CSRF_HEADER, toolkitHandler, type WebRuntime } from '../src/web.js'
import type { PublicState } from '../src/shared.js'

describe('host web session boundary', () => {
  let server: Server
  let origin: string
  const token = 'synthetic-process-csrf-capability'
  let runtime: WebRuntime
  const state: PublicState = { models: [], status: 'missing', selectedModelId: null, canSelect: false, lastSyncAt: null, error: null }
  beforeEach(async () => {
    runtime = {
      getState: vi.fn(() => state), selectModel: vi.fn(async () => state), refresh: vi.fn(async () => state),
    }
    const handler = toolkitHandler(runtime, () => origin, token)
    server = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const headers = () => ({ [CSRF_HEADER]: token, 'Content-Type': 'application/json', Origin: origin })

  it('requires the process capability even for state reads', async () => {
    expect((await fetch(`${origin}${API_ROOT}/state`)).status).toBe(403)
    const response = await fetch(`${origin}${API_ROOT}/state`, { headers: headers() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(state)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses hostile Origins, null Origins, DNS rebinding Hosts and foreign Fetch Metadata', async () => {
    const hostile: Record<string, string>[] = [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { Host: `attacker.example:${(server.address() as AddressInfo).port}` }, { 'Sec-Fetch-Site': 'cross-site' }]
    for (const extra of hostile) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${origin}${API_ROOT}/refresh`, { method: 'POST', headers: { ...headers(), ...extra } }, response => {
          response.resume()
          resolve(response.statusCode)
        })
        request.on('error', reject)
        request.end('{}')
      })
      expect(status, JSON.stringify(extra)).toBe(403)
    }
    expect(runtime.refresh).not.toHaveBeenCalled()
  })

  it('accepts only a model ID from the browser and returns no connection data', async () => {
    const response = await fetch(`${origin}${API_ROOT}/model`, { method: 'POST', headers: headers(), body: JSON.stringify({ modelId: 'qoder/test' }) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('apiKey')
    expect(body).not.toHaveProperty('baseURL')
    expect(runtime.selectModel).toHaveBeenCalledWith('qoder/test')
  })

  it('rejects non-JSON, malformed JSON and oversized bodies before invoking runtime', async () => {
    expect((await fetch(`${origin}${API_ROOT}/model`, { method: 'POST', headers: { ...headers(), 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415)
    expect((await fetch(`${origin}${API_ROOT}/model`, { method: 'POST', headers: headers(), body: '{' })).status).toBe(400)
    expect((await fetch(`${origin}${API_ROOT}/model`, { method: 'POST', headers: headers(), body: JSON.stringify({ modelId: 'a'.repeat(270_000) }) })).status).toBe(413)
    expect(runtime.selectModel).not.toHaveBeenCalled()
  })

  it('does not reflect raw exception messages or secrets', async () => {
    vi.mocked(runtime.selectModel).mockRejectedValue(new Error('private synthetic-secret'))
    const response = await fetch(`${origin}${API_ROOT}/model`, { method: 'POST', headers: headers(), body: '{"modelId":"test"}' })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('synthetic-secret')
  })

  it('removes obsolete manual connection, key and budget write endpoints', async () => {
    for (const path of ['/connection', '/settings', '/forget']) {
      expect((await fetch(`${origin}${API_ROOT}${path}`, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(404)
    }
    expect(runtime.selectModel).not.toHaveBeenCalled()
  })
})
