import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { API_ROOT } from './shared.js'
import type { ToolkitRuntime } from './runtime.js'

export const CSRF_GLOBAL = '__DSH_CONNECT_AI_TOOLKIT_CSRF__'
export const CSRF_HEADER = 'x-dsh-ai-toolkit-csrf'
const MAX_BODY_BYTES = 256 * 1024

export type WebRuntime = Pick<ToolkitRuntime, 'getState' | 'selectModel' | 'refresh'>

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameToken(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** The per-process capability is delivered only through the host's boot page. */
export function requireLocalSession(req: IncomingMessage, origin: string, csrfToken: string): boolean {
  try {
    const listener = new URL(origin)
    if (!['127.0.0.1', '[::1]'].includes(listener.hostname)) return false
    if (!loopback(req.socket.remoteAddress)) return false
    const rawHost = req.headers.host
    if (!rawHost) return false
    const requestOrigin = new URL(`${listener.protocol}//${rawHost}`)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestOrigin.hostname)
      || requestOrigin.port !== listener.port || requestOrigin.username || requestOrigin.password
      || requestOrigin.pathname !== '/' || requestOrigin.search || requestOrigin.hash) return false
    const browserOrigin = req.headers.origin
    if (browserOrigin !== undefined && browserOrigin !== requestOrigin.origin) return false
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    return sameToken(req.headers[CSRF_HEADER], csrfToken)
  } catch {
    return false
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, '请求必须使用 application/json')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_BODY_BYTES) throw new RequestError(413, '请求正文过大')
    chunks.push(bytes)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RequestError(400, '请求 JSON 无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, '请求必须为 JSON 对象')
  }
  return value as Record<string, unknown>
}

/** A handler independent of Cordis so its security boundary can be tested over HTTP. */
export function toolkitHandler(runtime: WebRuntime, getOrigin: () => string, csrfToken: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireLocalSession(req, getOrigin(), csrfToken)) {
      json(res, 403, { error: '请从当前 DSH 页面访问插件设置' })
      return
    }
    const path = new URL(req.url ?? '/', getOrigin()).pathname
    if (path === `${API_ROOT}/state` && req.method === 'GET') {
      json(res, 200, runtime.getState())
      return
    }
    const action = path.slice(API_ROOT.length)
    if (!['/model', '/refresh'].includes(action)) {
      json(res, 404, { error: '接口不存在' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: '请求方法不支持' })
      return
    }
    try {
      const body = await readJson(req)
      let result: unknown
      if (action === '/model') {
        if (typeof body.modelId !== 'string') throw new RequestError(400, '请选择有效的模型')
        result = await runtime.selectModel(body.modelId)
      } else result = await runtime.refresh()
      json(res, 200, result)
    } catch (error) {
      // Runtime validation is deliberately phrased without echoing credentials.
      json(res, error instanceof RequestError ? error.status : 400, {
        error: error instanceof RequestError ? error.message : '模型设置未保存，请确认代理已开启、模型仍然可用且 DSH 支持保存默认模型。',
      })
    }
  }
}

export function registerToolkitWeb(ctx: Context, runtime: WebRuntime): () => void {
  const csrfToken = randomBytes(32).toString('base64url')
  const handler = toolkitHandler(runtime, () => ctx.webServer.getOrigin(), csrfToken)
  const disposeInjection = ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: CSRF_GLOBAL, value: csrfToken })
  })
  const disposeRoutes = ['/state', '/model', '/refresh'].map(path =>
    ctx.webServer.register({ kind: 'exact', path: `${API_ROOT}${path}`, handler }))
  return () => {
    disposeInjection()
    for (const dispose of disposeRoutes) dispose()
  }
}
