import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AttachmentId, ImageVariantId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createToolkitAdapter, gatewayFetch, type AdapterRuntime } from '../src/adapter.js'
import { defaultSettings, PROVIDER_ID } from '../src/shared.js'
import type { PluginSettings, PublicState } from '../src/shared.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function gateway(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

function runtime(baseURL: string, ids = ['workbuddy/model-with/slash']): AdapterRuntime & { settings: PluginSettings } {
  const settings = { ...defaultSettings(), baseURL }
  return {
    settings,
    getSettings: () => structuredClone(settings),
    getState: () => ({ models: ids.map(id => ({ id, name: id, source: 'test' })), status: 'connected', selectedModelId: null, canSelect: true, lastSyncAt: null, error: null } as PublicState),
    getApiKey: async expectedBaseURL => {
      if (expectedBaseURL !== undefined && expectedBaseURL !== settings.baseURL) throw new Error('Proxy endpoint changed')
      return 'synthetic-proxy-key'
    },
  }
}

const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
function request(model = 'workbuddy/model-with/slash'): GenerateOptions {
  return { provider: PROVIDER_ID, model, messages: [user] }
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
function sse(values: unknown[]): string {
  return values.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'
}
function chunk(delta: unknown, finish: string | null = null) {
  return { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }
}

describe('AI-Toolkit PiAiAdapter', () => {
  it('registers a usable provider route in the real host context before any key or models exist', async () => {
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    const source = runtime('http://127.0.0.1:17860/v1', [])
    source.getApiKey = async () => { throw new Error('No key configured') }
    const { adapter } = createToolkitAdapter({ runtime: source })
    const unregister = llm.registerAdapter([PROVIDER_ID], adapter)
    expect(llm.listProviders()).toContainEqual({ id: PROVIDER_ID, name: 'AI-Toolkit（自动连接）' })
    expect(await llm.listModels(PROVIDER_ID)).toEqual([])
    unregister()
  })

  it('coexists with an existing generic ai-toolkit provider without replacing it', async () => {
    const ctx = new Context()
    const llm = new LlmRuntime(ctx)
    class ExistingAdapter extends LlmAdapter {
      async *stream(): AsyncIterable<StreamChunk> { /* Registration-only fixture. */ }
    }
    const existing = new ExistingAdapter()
    const removeExisting = llm.registerAdapter(['ai-toolkit'], existing)
    const previous = llm.listProviders()
    const { adapter } = createToolkitAdapter({ runtime: runtime('http://127.0.0.1:17860/v1') })
    const removePlugin = llm.registerAdapter([PROVIDER_ID], adapter)
    expect(llm.listProviders()).toEqual([...previous, { id: PROVIDER_ID, name: 'AI-Toolkit（自动连接）' }])
    expect((await llm.listModels(PROVIDER_ID)).map(model => model.id)).toEqual(['workbuddy/model-with/slash'])
    removePlugin()
    expect(llm.listProviders()).toEqual(previous)
    expect(await llm.listModels('ai-toolkit')).toEqual([])
    removeExisting()
  })

  it('advertises every exact ID with explicit client budgets and no reasoning levels', async () => {
    const source = runtime('http://127.0.0.1:17860/v1', ['workbuddy/x', 'traework/x', 'qoder/x', 'glm-verified'])
    const { adapter, invalidate } = createToolkitAdapter({ runtime: source })
    expect((await adapter.listModels(PROVIDER_ID)).map(model => model.id)).toEqual(['workbuddy/x', 'traework/x', 'qoder/x', 'glm-verified'])
    const info = await adapter.resolveModel(PROVIDER_ID, 'qoder/x')
    expect(info.context?.contextWindow).toBe(32768)
    expect(info.defaultMaxTokens).toBe(4096)
    expect(info.inputModalities).toEqual(['text'])
    expect(info.reasoning).toBeUndefined()
    expect(adapter.providerRetryPolicy(PROVIDER_ID)).toMatchObject({ mode: 'normal', maxRetries: 0 })
    source.settings.overrides['qoder/x'] = { contextWindow: 65536, maxTokens: 2048, images: true }
    invalidate()
    const changed = await adapter.resolveModel(PROVIDER_ID, 'qoder/x')
    expect(changed.context?.contextWindow).toBe(65536)
    expect(changed.defaultMaxTokens).toBe(2048)
    expect(changed.inputModalities).toEqual(['text', 'image'])
  })

  it('streams text, reasoning and usage without requesting a reasoning effort', async () => {
    let sent: Record<string, unknown> = {}
    let auth: string | undefined
    const baseURL = await gateway(async (req, res) => {
      auth = req.headers.authorization
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part))
      sent = JSON.parse(Buffer.concat(parts).toString())
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse([
        chunk({ role: 'assistant', reasoning_content: 'thinking' }),
        chunk({ content: 'hello' }),
        { ...chunk({}, 'stop'), usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
      ]))
    })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const output = await collect(adapter.stream(request()))
    expect(auth, JSON.stringify(output)).toBe('Bearer synthetic-proxy-key')
    expect(sent.model).toBe('workbuddy/model-with/slash')
    expect(sent.max_tokens).toBe(4096)
    expect(sent.reasoning_effort).toBeUndefined()
    expect(output).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'thinking' })
    expect(output.some(value => value.type === 'text-delta' && value.text === 'hello')).toBe(true)
    expect(output.some(value => value.type === 'usage' && value.usage.outputTokens === 3)).toBe(true)
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('uses the real catalog context so a long MiniMax conversation is not clamped to one output token', async () => {
    const sent: Record<string, unknown>[] = []
    const baseURL = await gateway(async (req, res) => {
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part))
      sent.push(JSON.parse(Buffer.concat(parts).toString()))
      const truncated = sent.at(-1)?.max_tokens === 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse([chunk(truncated ? {} : { content: 'complete' }), chunk({}, truncated ? 'length' : 'stop')]))
    })
    const id = 'minimax-code/MiniMax-M3.1-Flash'
    const source = runtime(baseURL, [id])
    const { adapter, invalidate } = createToolkitAdapter({ runtime: source })
    const longRequest = { ...request(id), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(105_000) }] })] }
    expect((await collect(adapter.stream(longRequest))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(sent.at(-1)?.max_tokens).toBe(1)

    const state = source.getState()
    source.getState = () => ({ ...state, models: [{ ...state.models[0], contextWindow: 1_000_000 }] })
    invalidate()
    expect((await adapter.resolveModel(PROVIDER_ID, id)).context?.contextWindow).toBe(1_000_000)
    expect((await collect(adapter.stream(longRequest))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(sent.at(-1)?.max_tokens).toBe(4096)
    // A caller's deliberate cap remains authoritative, and a real truncation remains visible.
    expect((await collect(adapter.stream({ ...longRequest, maxTokens: 1 }))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(sent.at(-1)?.max_tokens).toBe(1)
  })

  it('uses declared output capacity while preserving explicit per-model client overrides', async () => {
    const source = runtime('http://127.0.0.1:17860/v1', ['qoder/x'])
    const state = source.getState()
    source.getState = () => ({ ...state, models: [{ ...state.models[0], contextWindow: 1_000_000, maxOutputTokens: 32_768 }] })
    const { adapter, invalidate } = createToolkitAdapter({ runtime: source })
    expect(await adapter.resolveModel(PROVIDER_ID, 'qoder/x')).toMatchObject({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 32_768 })
    source.settings.overrides['qoder/x'] = { contextWindow: 65536, maxTokens: 2048 }
    invalidate()
    expect(await adapter.resolveModel(PROVIDER_ID, 'qoder/x')).toMatchObject({ context: { contextWindow: 65536 }, defaultMaxTokens: 2048 })
  })

  it('preserves fragmented tool calls and the matching tool result on the next request', async () => {
    const sent: Record<string, unknown>[] = []
    const baseURL = await gateway(async (req, res) => {
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part))
      sent.push(JSON.parse(Buffer.concat(parts).toString()))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sent.length === 1 ? sse([
        chunk({ tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: 'read_fixture', arguments: '{"name":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"safe"}' } }] }),
        chunk({}, 'tool_calls'),
      ]) : sse([chunk({ content: 'done' }), chunk({}, 'stop')]))
    })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const first = await collect(adapter.stream({ ...request(), tools: [{ name: 'read_fixture', description: 'Read fixture', parameters: { type: 'object', properties: { name: { type: 'string' } } } }] }))
    expect(first.some(value => value.type === 'block-end' && value.block.type === 'tool-call' && value.block.arguments === '{"name":"safe"}')).toBe(true)
    const callId = ToolCallId('call-fixture')
    await collect(adapter.stream({
      ...request(),
      messages: [user, createAssistantMessage({ source: { provider: PROVIDER_ID, model: request().model }, content: [{ type: 'tool-call', id: callId, name: 'read_fixture', arguments: '{"name":"safe"}' }] }),
        createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'fixture result' }] })],
      tools: [{ name: 'read_fixture', description: 'Read fixture', parameters: { type: 'object' } }],
    }))
    expect(sent[0].tools).toBeDefined()
    expect(sent[1].messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call-fixture', content: 'fixture result' }))
  })

  it('forwards attachment bytes only after the user enables images for that model', async () => {
    const sent: Record<string, unknown>[] = []
    const baseURL = await gateway(async (req, res) => {
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.from(part))
      sent.push(JSON.parse(Buffer.concat(parts).toString()))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse([chunk({ content: 'image fixture received' }), chunk({}, 'stop')]))
    })
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64')
    const ref: ImageAttachmentRef = { attachmentId: AttachmentId('a'.repeat(64)), bytes: data.length, width: 1, height: 1, mediaType: 'image/png' }
    const readImageRequest = vi.fn(async () => ({ attachment: ref, variantId: ImageVariantId('b'.repeat(64)), data, bytes: data.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true, mediaType: 'image/png' }))
    const source = runtime(baseURL)
    const { adapter, invalidate } = createToolkitAdapter({ runtime: source, resolveAttachments: () => ({ readImageRequest } as unknown as AttachmentStore) })
    const withImage = { ...request(), messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] })] }
    await expect(collect(adapter.stream(withImage))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(sent).toHaveLength(0)
    source.settings.overrides[request().model] = { images: true }
    invalidate()
    const accepted = await collect(adapter.stream(withImage))
    expect(readImageRequest).toHaveBeenCalledOnce()
    expect(JSON.stringify(sent[0])).toContain(`data:image/png;base64,${data.toString('base64')}`)
    expect(accepted.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('ends an interrupted response as an error without replaying already emitted content', async () => {
    let calls = 0
    const baseURL = await gateway((_req, res) => {
      calls++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'partial' }))}\n\n`)
      setTimeout(() => res.destroy(), 10)
    })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const output = await collect(adapter.stream(request()))
    expect(output.some(value => value.type === 'text-delta' && value.text === 'partial')).toBe(true)
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(calls).toBe(1)
  })

  it('does not retry deterministic gateway failures', async () => {
    let calls = 0
    const baseURL = await gateway((_req, res) => {
      calls++
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: '该模型当前可用通道不支持工具调用', code: 'tools_not_supported', type: 'invalid_request_error' } }))
    })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const output = await collect(adapter.stream({ ...request(), tools: [{ name: 'read_fixture', description: '', parameters: { type: 'object' } }] }))
    expect(calls).toBe(1)
    expect(JSON.stringify(output)).toContain('不支持工具调用')
    expect(JSON.stringify(output)).toContain('tools_not_supported')
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('rejects inference redirects before sending the proxy key to the target', async () => {
    let reached = 0
    const target = await gateway((_req, res) => { reached++; res.end('unexpected') })
    const baseURL = await gateway((_req, res) => { res.writeHead(307, { Location: `${target}/chat/completions` }); res.end() })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const output = await collect(adapter.stream(request()))
    expect(reached).toBe(0)
    expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('never sends a newly configured key to a previously prepared endpoint', async () => {
    let oldRequests = 0
    const oldURL = await gateway((_req, res) => { oldRequests++; res.end() })
    const source = runtime(oldURL)
    const { adapter, invalidate } = createToolkitAdapter({ runtime: source })
    const prepared = await adapter.prepareCall(PROVIDER_ID, request().model)
    source.settings.baseURL = 'http://127.0.0.1:17861/v1'
    invalidate()
    await expect(collect(prepared.stream(request()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(oldRequests).toBe(0)
  })

  it('forwards cancellation to the HTTP response instead of leaving the upstream running', async () => {
    let closed = false
    const baseURL = await gateway((_req, res) => {
      res.on('close', () => { closed = true })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'partial' }))}\n\n`)
    })
    const { adapter } = createToolkitAdapter({ runtime: runtime(baseURL) })
    const controller = new AbortController()
    const output: StreamChunk[] = []
    try {
      for await (const value of adapter.stream({ ...request(), signal: controller.signal })) {
        output.push(value)
        if (value.type === 'text-delta') controller.abort()
      }
    } catch (error) {
      expect(error).toMatchObject({ code: 'ABORTED' })
    }
    expect(output.some(value => value.type === 'text-delta')).toBe(true)
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it('applies redirect:error at the provider transport and refuses other endpoints', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('{}'))
    const fetch = gatewayFetch('http://127.0.0.1:17860/v1', transport)
    await fetch('http://127.0.0.1:17860/v1/chat/completions', { method: 'POST' })
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('error')
    await expect(fetch('https://example.com/v1/chat/completions', { method: 'POST' })).rejects.toThrow('cannot leave')
    await expect(fetch('http://127.0.0.1:17860/v1/models')).rejects.toThrow('cannot leave')
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
