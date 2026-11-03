// Development-only proxy fixture. No external calls or real credentials.
import { createServer } from 'node:http'
const key = 'fixture-only-not-a-real-proxy-key'
const models = ['workbuddy/demo-chat', 'traework/demo-chat', 'qoder/demo-chat', 'demo-chat']
const server = createServer(async (req, res) => {
  if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok"}'); return }
  if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end('{"error":{"code":"invalid_api_key"}}'); return }
  if (req.url === '/v1/models' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: id.includes('/') ? id.split('/')[0] : 'auto' })) }))
    return
  }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 32 * 1024 * 1024) { res.writeHead(413); res.end(); return }
    parts.push(part)
  }
  let body
  try { body = JSON.parse(Buffer.concat(parts).toString()) } catch { res.writeHead(400); res.end(); return }
  const content = '模拟代理连接成功。此回复来自本地测试服务，没有调用任何真实平台或消耗积分。'
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const choice of [{ delta: { role: 'assistant', content }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`)
  }
  res.end('data: [DONE]\n\n')
})
server.listen(4182, '127.0.0.1', () => console.log('Development proxy fixture: http://127.0.0.1:4182/v1 (synthetic credentials only)'))
process.on('SIGINT', () => { server.closeAllConnections(); server.close() })
process.on('SIGTERM', () => { server.closeAllConnections(); server.close() })
