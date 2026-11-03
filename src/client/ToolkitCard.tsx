import { useEffect, useId, useRef, useState } from 'react'
import { DOWNLOAD_URL, type PublicState } from '../shared.ts'
import { createHttpApi, type ToolkitApi } from './api.ts'
import { toolkitStyles } from './styles.ts'
import { aiToolkitLogo, platformLogos } from './logos.ts'

export type { ToolkitApi } from './api.ts'
export { createHttpApi } from './api.ts'

const defaultApi = createHttpApi()
const sourceNames = new Map([['workbuddy', 'WorkBuddy'], ['traework', 'TRAE CN'], ['qoder', 'Qoder'], ['auto', '自动路由']])

function ConnectionGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8.5 14.5 7-7m-9 10H5a3 3 0 0 1-3-3V13a3 3 0 0 1 .88-2.12l4-4A3 3 0 0 1 9 6h1.5m3 12H15a3 3 0 0 0 2.12-.88l4-4A3 3 0 0 0 22 11V9.5a3 3 0 0 0-3-3h-1.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
}

/** One real DSH default-model selector; the Host discovers the local connection. */
export function ToolkitCard({ api = defaultApi }: { api?: ToolkitApi }) {
  const id = useId()
  const helperId = `${id}-help`
  const [state, setState] = useState<PublicState | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const operation = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let active = true
    let reading = false
    async function read() {
      if (reading || operation.current) return
      reading = true
      const ticket = generation.current
      try {
        const value = await api.getState()
        if (active && !operation.current && ticket === generation.current) { setState(value); setLoadError(null) }
      } catch (cause: unknown) {
        if (active && ticket === generation.current) setLoadError(cause instanceof Error ? cause.message : '无法读取插件状态。')
      } finally { reading = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 5_000)
    return () => { active = false; mounted.current = false; clearInterval(timer) }
  }, [api])

  async function perform(kind: 'retry' | 'select', modelId?: string) {
    if (operation.current) return
    operation.current = true
    ++generation.current
    setBusy(true); setActionError(null); setLoadError(null)
    setPending(kind === 'select' ? modelId ?? null : null)
    try {
      const value = await (kind === 'retry' ? api.refresh() : api.selectModel(modelId!))
      if (mounted.current) setState(value)
    } catch (cause: unknown) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : '操作未完成，请重试。')
      try {
        const value = await api.getState()
        if (mounted.current) setState(value)
      } catch { /* Keep the last confirmed selection when the Host is also unavailable. */ }
    } finally {
      operation.current = false
      if (mounted.current) { setBusy(false); setPending(null) }
    }
  }

  const connected = state?.status === 'connected'
  const ready = connected && state.canSelect && !busy
  const failed = state !== null && state.status !== 'connected' && state.status !== 'detecting'
  const unavailableSelection = state?.selectedModelId && !state.models.some((model) => model.id === state.selectedModelId)
  function retryIfNeeded() { if (failed || loadError !== null) void perform('retry') }

  let helper = '用于新会话，已有会话在会话内切换。'
  if (busy) helper = pending === null ? '正在重新检测 AI-Toolkit…' : '正在保存新会话默认模型…'
  else if (actionError || loadError) helper = actionError ?? loadError!
  else if (state === null || state.status === 'detecting') helper = '正在自动检测 AI-Toolkit…首次访问时请允许系统凭据授权。'
  else if (state.status === 'credential-denied') helper = '请允许系统凭据授权，再点击下拉框重新检测。'
  else if (state.status === 'missing') helper = '请安装并打开 AI-Toolkit，开启本地代理。点击下拉框重新检测。'
  else if (state.status === 'offline') helper = '请打开 AI-Toolkit 并开启本地代理。点击下拉框重新检测。'
  else if (state.status === 'unauthorized') helper = '代理密钥已失效，请在 AI-Toolkit 中检查代理。点击下拉框重新检测。'
  else if (state.status === 'unsupported') helper = '当前 AI-Toolkit 连接信息暂不受支持。点击下拉框重新检测。'
  else if (!state.canSelect) helper = '当前 DSH 未提供保存默认模型所需的服务。'
  else if (state.models.length === 0) helper = '代理尚未提供可用模型，请在 AI-Toolkit 中检查账号与目录。'

  const showDownload = state?.status === 'missing' || state?.status === 'offline'
  const selected = pending ?? state?.selectedModelId ?? ''
  const model = state?.models.find((item) => item.id === selected)
  const modelLogo = model ? platformLogos.get(model.source) : aiToolkitLogo
  const detecting = busy || (!loadError && (state === null || state.status === 'detecting'))
  const hasError = Boolean(failed || actionError || loadError)
  const statusLabel = detecting ? (pending ? '保存中' : '检测中') : hasError ? (state?.status === 'credential-denied' ? '待授权' : showDownload ? '待开启' : '需检查') : connected ? '已连接' : '待连接'
  const modelTitle = model?.name || (selected ? selected : connected ? '选择一个模型' : detecting ? '正在连接 AI-Toolkit' : '等待代理连接')
  const modelDetail = model ? `${sourceNames.get(model.source) ?? model.source} · ${model.id}` : selected ? '当前模型不可用，请重新选择' : connected ? '自动同步全部可用模型' : '打开 AI-Toolkit 并开启本地代理'

  return <div className="ait-card" data-tone={hasError ? 'warning' : connected && !detecting ? 'success' : 'waiting'} data-busy={detecting}>
    <style>{toolkitStyles}</style>
    <header className="ait-header">
      <div className="ait-brand">
        <span className="ait-brand-mark" aria-hidden="true"><img src={aiToolkitLogo} alt="" draggable={false} /></span>
        <div className="ait-brand-copy"><h2 className="ait-title">AI-Toolkit</h2><p className="ait-subtitle">本地模型连接</p></div>
      </div>
      <span className="ait-status"><i className="ait-status-dot" aria-hidden="true" />{statusLabel}</span>
    </header>
    <div className="ait-divider" aria-hidden="true" />
    <div className="ait-field">
      <div className="ait-field-heading"><label className="ait-label" htmlFor={id}>新会话默认模型</label>{connected ? <span className="ait-model-count">{state.models.length} 个可用模型</span> : null}</div>
      <div className="ait-picker" data-available={ready}>
        <span className="ait-model-mark" data-source={model?.source ?? 'unknown'} data-has-logo={Boolean(modelLogo)} aria-hidden="true">{modelLogo ? <img src={modelLogo} alt="" draggable={false} /> : <ConnectionGlyph />}</span>
        <div className="ait-model-display" aria-hidden="true"><span className="ait-model-title">{modelTitle}</span><span className="ait-model-id">{modelDetail}</span></div>
        <svg className="ait-picker-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <select id={id} className="ait-select" value={selected} aria-describedby={helperId} aria-busy={detecting} onFocus={retryIfNeeded} onPointerDown={retryIfNeeded} onChange={(event) => { if (ready && event.target.value) void perform('select', event.target.value) }}>
          <option value="" disabled>{connected ? '选择 AI-Toolkit 模型' : '等待 AI-Toolkit 代理连接'}</option>
          {unavailableSelection ? <option value={state.selectedModelId!} disabled>{state.selectedModelId}（当前不可用）</option> : null}
          {state?.models.map((model) => <option key={model.id} value={model.id} disabled={!ready}>{sourceNames.get(model.source) ?? model.source} · {model.name === model.id ? model.id : `${model.name} (${model.id})`}</option>)}
        </select>
      </div>
    </div>
    <p id={helperId} className="ait-helper" data-tone={hasError ? 'error' : undefined} role={hasError ? 'status' : undefined}>
      <span className="ait-helper-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.2"/><path d="M8 7v4m0-6v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg></span>
      <span className="ait-helper-copy">{helper}{showDownload ? <> <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">下载 AI-Toolkit</a></> : null}</span>
    </p>
  </div>
}
