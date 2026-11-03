import { ConfigStore, pluginDirectory } from './config.ts'
import { discover, discoverBaseURL, DiscoveryError, type DiscoveredConnection } from './discovery.ts'
import { fetchModels, GatewayError, normalizeBaseURL } from './http.ts'
import { defaultSettings, PROVIDER_ID, type ModelSelection, type PluginSettings, type PublicState } from './shared.ts'

/** Automatic connection metadata and keys are private and never serialized. */
export class ToolkitRuntime {
  private readonly store: ConfigStore
  private readonly discover: () => Promise<DiscoveredConnection>
  private readonly resolveAddress: () => Promise<string>
  private readonly selection?: ModelSelection
  private settings = defaultSettings()
  private state: PublicState = { models: [], status: 'detecting', selectedModelId: null, canSelect: false, lastSyncAt: null, error: null }
  private key: string | null = null
  private credentialBlocked = false
  private listeners = new Set<() => void>()
  private pending: Promise<unknown> = Promise.resolve()
  private refreshing?: Promise<PublicState>
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private stopped = false

  constructor(options: { directory?: string; discover?: () => Promise<DiscoveredConnection>; resolveAddress?: () => Promise<string>; selection?: ModelSelection } = {}) {
    this.store = new ConfigStore(options.directory ?? pluginDirectory())
    this.discover = options.discover ?? discover
    this.resolveAddress = options.resolveAddress ?? (options.discover ? async () => this.settings.baseURL : discoverBaseURL)
    this.selection = options.selection
  }
  getState(): PublicState {
    const selected = this.selection?.current()
    return structuredClone({
      ...this.state,
      canSelect: this.state.status === 'connected' && this.selection?.available() === true,
      selectedModelId: selected?.provider === PROVIDER_ID ? selected.model : null,
    })
  }
  getSettings(): PluginSettings { return structuredClone(this.settings) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(() => {
      if (this.stopped) throw new Error('插件已停止。')
      return operation()
    })
    this.pending = next.catch(() => {})
    return next
  }
  async start(): Promise<void> {
    await this.serialize(async () => {
      // Preserve v0.1 client budgets only. Saved addresses and manual keys are ignored.
      try {
        const saved = await this.store.load()
        this.settings = { ...saved.settings, baseURL: defaultSettings().baseURL }
      } catch { /* Invalid legacy settings use the explicit client defaults. */ }
      await this.performRefresh(false)
    })
    this.schedule()
  }
  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.refresh(false).catch(() => {}).finally(() => this.schedule())
    }, this.state.status === 'connected' ? 30_000 : 5_000)
    this.timer.unref()
  }
  dispose(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort()
    this.key = null
    this.listeners.clear()
  }
  async getApiKey(expectedBaseURL?: string): Promise<string> {
    if (this.stopped || !this.key || this.state.status !== 'connected') throw new Error('请打开 AI-Toolkit 并开启本地代理。')
    if (expectedBaseURL !== undefined && normalizeBaseURL(expectedBaseURL) !== this.settings.baseURL) throw new Error('代理地址已变更，请重新发起请求。')
    return this.key
  }
  refresh(manual = true): Promise<PublicState> {
    if (this.refreshing) return this.refreshing
    const task = this.serialize(() => this.performRefresh(manual))
    this.refreshing = task
    void task.finally(() => { if (this.refreshing === task) this.refreshing = undefined }).catch(() => {})
    return task
  }
  private async detect(): Promise<void> {
    if (this.stopped) return
    this.state.status = 'detecting'
    this.emit()
    const connection = await this.discover()
    if (this.stopped) return
    const baseURL = normalizeBaseURL(connection.baseURL)
    if (typeof connection.apiKey !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(connection.apiKey)) {
      throw new DiscoveryError('credential-denied', 'AI-Toolkit 代理凭据格式无效，请重新开启代理。')
    }
    if (baseURL !== this.settings.baseURL) this.state.models = []
    this.settings = { ...this.settings, baseURL }
    this.key = connection.apiKey
  }
  private async performRefresh(manual: boolean): Promise<PublicState> {
    // A denied OS authorization is retried only when the user focuses/clicks the dropdown.
    if (this.credentialBlocked && !manual) return this.getState()
    if (manual) this.credentialBlocked = false
    if (!this.key) this.state.status = 'detecting'
    this.state.error = null
    this.emit()
    try {
      if (this.key) {
        const currentAddress = normalizeBaseURL(await this.resolveAddress())
        if (this.stopped) return this.getState()
        if (currentAddress !== this.settings.baseURL) this.key = null
      }
      if (!this.key) await this.detect()
      if (this.stopped) return this.getState()
      this.controller = new AbortController()
      let models
      try { models = await fetchModels(this.settings.baseURL, this.key!, this.controller.signal) }
      catch (error) {
        // Only directory reads recover a local key rotation; inference is never replayed.
        if (!(error instanceof GatewayError) || error.status !== 401) throw error
        this.key = null
        await this.detect()
        if (this.stopped) return this.getState()
        models = await fetchModels(this.settings.baseURL, this.key!, this.controller.signal)
      }
      if (this.stopped) return this.getState()
      this.state.models = models
      this.state.lastSyncAt = Date.now()
      this.state.status = 'connected'
    } catch (error) {
      if (this.stopped) return this.getState()
      if (error instanceof DiscoveryError) {
        if (error.code === 'credential-denied' || error.code === 'unsupported') this.key = null
        this.state.status = error.code
        this.state.error = error.message
        this.credentialBlocked = error.code === 'credential-denied'
      } else {
        this.state.status = error instanceof GatewayError && error.status === 401 ? 'unauthorized' : 'offline'
        if (this.state.status === 'unauthorized') {
          this.key = null
          this.credentialBlocked = true
        }
        this.state.error = this.state.status === 'unauthorized' ? '代理密钥尚未同步，请在 AI-Toolkit 中关闭后重新开启代理。' : '无法连接 AI-Toolkit，请打开应用并开启本地代理。'
      }
    } finally { this.controller = undefined }
    this.emit()
    return this.getState()
  }
  async selectModel(modelId: string): Promise<PublicState> {
    return this.serialize(async () => {
      if (this.state.status !== 'connected' || !this.key) throw new Error('请先开启 AI-Toolkit 本地代理。')
      if (typeof modelId !== 'string' || !this.state.models.some(model => model.id === modelId)) throw new Error('该模型已不在当前代理目录中。')
      if (!this.selection?.available()) throw new Error('当前 DSH 宿主不支持保存默认模型，请检查 DSH 版本。')
      await this.selection.save(modelId)
      const saved = this.selection.current()
      if (saved?.provider !== PROVIDER_ID || saved.model !== modelId) throw new Error('DSH 默认模型未保存成功，请重新选择。')
      this.emit()
      return this.getState()
    })
  }
}
