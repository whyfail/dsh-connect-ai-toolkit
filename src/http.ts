import type { GatewayModel } from './shared.ts'

export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
    this.name = 'GatewayError'
  }
}

export function normalizeBaseURL(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('请输入有效的本机代理地址。') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('代理地址必须是本机回环地址：127.0.0.1、localhost 或 [::1]。')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('代理地址不能包含账号、密码、查询参数或片段。')
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/v1') throw new Error('请填写代理根地址或以 /v1 结尾的 Base URL。')
  // Avoid both DNS resolution and localhost's IPv6 preference for the IPv4 AI-Toolkit listener.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  url.pathname = '/v1'
  return url.toString().replace(/\/$/, '')
}

/** Also used by the inference adapter: SDK redirects must never carry the key elsewhere. */
export function createLoopbackFetch(baseURL: string, transport: typeof fetch = globalThis.fetch): typeof fetch {
  const origin = new URL(normalizeBaseURL(baseURL)).origin
  return async (input, init) => {
    const requestURL = new URL(input instanceof Request ? input.url : String(input))
    if (requestURL.origin !== origin || requestURL.username || requestURL.password) {
      throw new GatewayError('invalid_proxy_target', '已阻止向本机代理以外的地址发送请求。')
    }
    return transport(input, { ...init, redirect: 'error' })
  }
}

export function redact(value: string, secret?: string): string {
  let result = value
  if (secret) result = result.split(secret).join('[redacted]')
  return result.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 500)
}

export function parseModels(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new GatewayError('invalid_model_catalog', '代理返回的模型目录格式不正确。')
  }
  const models = new Map<string, GatewayModel>()
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== 'object') throw new GatewayError('invalid_model_catalog', '模型条目格式不正确。')
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 1024 || /[\u0000-\u001f\u007f]/.test(row.id)) {
      throw new GatewayError('invalid_model_catalog', '模型目录包含无效 ID。')
    }
    const capacity = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    // ID remains byte-for-byte unchanged, including platform prefixes and auto aliases.
    models.set(row.id, {
      id: row.id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : row.id,
      source: typeof row.owned_by === 'string' && row.owned_by ? row.owned_by : 'unknown',
      ...(capacity(row.context_window) ? { contextWindow: row.context_window } : {}),
      ...(capacity(row.max_output_tokens) ? { maxOutputTokens: row.max_output_tokens } : {}),
    })
  }
  return [...models.values()]
}

export async function fetchModels(baseURL: string, key: string, signal?: AbortSignal): Promise<GatewayModel[]> {
  const base = normalizeBaseURL(baseURL)
  const guarded = createLoopbackFetch(base)
  const timeout = AbortSignal.timeout(5_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    // Liveness only; this response is never treated as a product/version attestation.
    const health = await guarded(new URL('/health', base), { signal: combined })
    await health.body?.cancel()
    if (!health.ok) throw new GatewayError('health_check_failed', `代理存活检测失败（HTTP ${health.status}）。`, health.status)
    const response = await guarded(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: combined,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new GatewayError(response.status === 401 ? 'invalid_api_key' : 'catalog_request_failed',
        response.status === 401 ? '代理密钥无效，请从 AI-Toolkit 重新复制 API Key。' : `读取模型目录失败（HTTP ${response.status}）。`, response.status)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new GatewayError('empty_model_catalog', '模型目录响应为空。')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 4 * 1024 * 1024) {
          await reader.cancel()
          throw new GatewayError('catalog_too_large', '模型目录超过 4 MiB，请检查代理地址。')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    try { return parseModels(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch (error) {
      if (error instanceof GatewayError) throw error
      throw new GatewayError('invalid_model_catalog', '代理未返回有效的 JSON 模型目录。')
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error
    if (signal?.aborted) throw error
    throw new GatewayError('proxy_unreachable', '无法连接本地代理，请确认 AI-Toolkit 已开启代理、端口正确且未发生重定向。')
  }
}
