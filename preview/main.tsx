import { createRoot } from 'react-dom/client'
import { ToolkitCard, type ToolkitApi } from '../src/client/ToolkitCard.tsx'
import type { GatewayModel, PublicState } from '../src/shared.ts'

const catalog: GatewayModel[] = [
  { id: 'workbuddy/demo-chat', name: 'demo-chat', source: 'workbuddy' },
  { id: 'traework/demo-chat', name: 'demo-chat', source: 'traework' },
  { id: 'qoder/demo-reasoner', name: 'demo-reasoner', source: 'qoder' },
  { id: 'demo-chat', name: 'demo-chat', source: 'auto' },
]
const params = new URLSearchParams(location.search)
const disconnected = params.has('offline')
const status = disconnected ? 'offline' : params.has('denied') ? 'credential-denied' : params.has('detecting') ? 'detecting' : 'connected'
const dark = params.get('theme') === 'dark'
document.documentElement.dataset.theme = dark ? 'dark' : 'light'
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
if (params.has('long')) catalog.push({ id: 'workbuddy/a-very-long-model-identifier-with-a-full-platform-prefix-and-version-2026-11-03', name: 'A model with a very long name for narrow screen verification', source: 'workbuddy' })
let state: PublicState = { models: status === 'connected' ? catalog : [], status, selectedModelId: params.has('long') ? catalog.at(-1)!.id : params.has('selected') ? catalog[2]!.id : null, canSelect: status === 'connected', lastSyncAt: Date.now(), error: null }
const clone = () => structuredClone(state)
const pause = () => new Promise(resolve => setTimeout(resolve, 180))
const api: ToolkitApi = {
  async getState() { return clone() },
  async selectModel(modelId) {
    await pause()
    state = { ...state, selectedModelId: modelId }
    return clone()
  },
  async refresh() {
    await pause()
    state = { ...state, status: 'connected', canSelect: true, models: catalog, lastSyncAt: Date.now() }
    return clone()
  },
}

createRoot(document.getElementById('root')!).render(<>
  <style>{'*{box-sizing:border-box}body{margin:0;background:#f4f6f7;color:#243039;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.preview-top{padding:22px 32px;border-bottom:1px solid #e3e8eb;display:flex;justify-content:space-between;gap:16px;font-size:12px}.preview-top strong{font-weight:550}.preview-top span{color:#64727e}.preview-shell{max-width:668px;margin:64px auto;padding:0 24px}.preview-shell>p{font-size:11px;letter-spacing:.2px;color:#64727e;margin:0 0 18px}.preview-shell .preview-sample{font-size:11px;line-height:1.8;margin-top:20px;color:#64727e}[data-theme=dark] body{background:#181e24;color:#e4e9ed}[data-theme=dark] .preview-top{border-color:#303b45}[data-theme=dark] .preview-top span,[data-theme=dark] .preview-shell>p{color:#a6b2bd}@media(max-width:600px){.preview-top{padding:18px 20px;flex-wrap:wrap}.preview-shell{padding:0 16px;margin:36px auto}}'}</style>
  <header className="preview-top"><strong>DeepSeek Harness · 插件配置</strong><span>组件预览 · 模拟代理</span></header>
  <main className="preview-shell"><p>插件 / DSH Connect AI-Toolkit</p><ToolkitCard api={api}/><p className="preview-sample">代理地址和密钥由插件后端自动读取。此预览使用模拟模型，不访问本地凭据或真实平台。</p></main>
</>)
