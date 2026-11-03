// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolkitCard } from '../src/client/ToolkitCard.tsx'
import { createHttpApi, type ToolkitApi } from '../src/client/api.ts'
import { type PublicState } from '../src/shared.ts'

const connected = (): PublicState => ({
  status: 'connected', selectedModelId: null, canSelect: true, lastSyncAt: 1_700_000_000_000, error: null,
  models: [
    { id: 'workbuddy/model-a', name: 'Model A', source: 'workbuddy' },
    { id: 'qoder/model-b', name: 'Model B', source: 'qoder' },
  ],
})
function mockApi(initial = connected()): ToolkitApi {
  return {
    getState: vi.fn().mockResolvedValue(initial), refresh: vi.fn().mockResolvedValue(connected()),
    selectModel: vi.fn().mockImplementation(async (modelId) => ({ ...initial, selectedModelId: modelId })),
  }
}
let root: Root | undefined
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => {
  if (root) { await act(async () => root?.unmount()); root = undefined }
  document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers()
  delete window.__DSH_CONNECT_AI_TOOLKIT_CSRF__
})
async function render(api: ToolkitApi) {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root?.render(<ToolkitCard api={api} />) })
}
function selector(): HTMLSelectElement { return document.querySelector('select')! }
function choose(value: string) {
  selector().value = value
  selector().dispatchEvent(new Event('change', { bubbles: true }))
}

describe('single model selector', () => {
  it('renders only one field, preserves IDs and sources, and saves the actual selected model', async () => {
    const api = mockApi(); await render(api)
    expect(document.querySelectorAll('select')).toHaveLength(1)
    expect(document.querySelectorAll('input,button')).toHaveLength(0)
    expect(document.querySelector('label')?.textContent).toBe('新会话默认模型')
    const option = [...selector().options].find((item) => item.value === 'workbuddy/model-a')!
    expect(option.textContent).toContain('Model A')
    expect(option.textContent).toContain('WorkBuddy')
    expect(option.textContent).toContain('workbuddy/model-a')
    await act(async () => { choose('qoder/model-b') })
    expect(api.selectModel).toHaveBeenCalledWith('qoder/model-b')
    expect(selector().value).toBe('qoder/model-b')
    expect(document.body.textContent).toContain('用于新会话，已有会话在会话内切换。')
    expect(api.refresh).not.toHaveBeenCalled()
  })

  it('shows the Toolkit brand and follows the selected model platform logo', async () => {
    const state = connected()
    state.models.push(
      { id: 'traework/model-c', name: 'Model C', source: 'traework' },
      { id: 'model-auto', name: 'Automatic model', source: 'auto' },
      { id: 'model-unknown', name: 'Unknown platform', source: 'unknown' },
    )
    await render(mockApi(state))
    expect(document.querySelector('.ait-brand-mark img')?.getAttribute('src')).toContain('ai-toolkit.png')
    for (const [modelId, logo] of [
      ['workbuddy/model-a', 'workbuddy.svg'],
      ['qoder/model-b', 'qoder.svg'],
      ['traework/model-c', 'trae.png'],
      ['model-auto', 'ai-toolkit.png'],
    ]) {
      await act(async () => { choose(modelId!) })
      expect(document.querySelector('.ait-model-mark img')?.getAttribute('src')).toContain(logo)
    }
    await act(async () => { choose('model-unknown') })
    expect(document.querySelector('.ait-model-mark img')).toBeNull()
    expect(document.querySelector('.ait-model-mark svg')).not.toBeNull()
  })

  it('keeps failed connections focusable and deduplicates pointer/focus retries', async () => {
    const api = mockApi({ ...connected(), status: 'missing', models: [] })
    let finish!: (state: PublicState) => void
    api.refresh = vi.fn().mockImplementation(() => new Promise<PublicState>((resolve) => { finish = resolve }))
    await render(api)
    expect(selector().disabled).toBe(false)
    expect(document.body.textContent).toContain('点击下拉框重新检测')
    expect(document.querySelector('a')?.href).toBe('https://github.com/whyfail/AI-Toolkit/releases/latest')
    await act(async () => {
      selector().dispatchEvent(new Event('pointerdown', { bubbles: true }))
      selector().focus()
    })
    expect(api.refresh).toHaveBeenCalledTimes(1)
    await act(async () => { finish(connected()) })
    expect(document.querySelector('a')).toBeNull()
    expect(selector().options).toHaveLength(3)
  })

  it('explains OS authorization failures without showing manual connection controls', async () => {
    await render(mockApi({ ...connected(), status: 'credential-denied', models: [] }))
    expect(document.body.textContent).toContain('请允许系统凭据授权')
    expect(selector().disabled).toBe(false)
    expect(document.querySelectorAll('input,button')).toHaveLength(0)
  })

  it('polls public state every five seconds and reflects a changed confirmed default', async () => {
    vi.useFakeTimers()
    const api = mockApi()
    await render(api)
    vi.mocked(api.getState).mockResolvedValue({ ...connected(), selectedModelId: 'qoder/model-b' })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.getState).toHaveBeenCalledTimes(2)
    expect(selector().value).toBe('qoder/model-b')
  })

  it('restores the confirmed model after a failed save', async () => {
    const api = mockApi({ ...connected(), selectedModelId: 'workbuddy/model-a' })
    api.selectModel = vi.fn().mockRejectedValue(new Error('DSH 未保存所选默认模型。'))
    await render(api)
    await act(async () => { choose('qoder/model-b') })
    expect(selector().value).toBe('workbuddy/model-a')
    expect(document.querySelector('.ait-model-mark img')?.getAttribute('src')).toContain('workbuddy.svg')
    expect(document.body.textContent).toContain('DSH 未保存所选默认模型。')
  })

  it('treats prototype-like model IDs and sources as plain text', async () => {
    const state = { ...connected(), models: [
      { id: '__proto__', name: 'Prototype model', source: 'constructor' },
      { id: 'constructor', name: 'Constructor model', source: '__proto__' },
    ] }
    const api = mockApi(state); await render(api)
    expect(selector().options).toHaveLength(3)
    expect(selector().textContent).toContain('Prototype model')
    expect(selector().textContent).toContain('constructor')
    expect(selector().textContent).toContain('__proto__')
    await act(async () => { choose('__proto__') })
    expect(api.selectModel).toHaveBeenCalledWith('__proto__')
    expect(selector().value).toBe('__proto__')
  })

  it('does not offer selectable models when host default saving is unavailable', async () => {
    await render(mockApi({ ...connected(), canSelect: false }))
    expect([...selector().options].every((option) => option.disabled)).toBe(true)
    expect(selector().disabled).toBe(false)
    expect(document.body.textContent).toContain('当前 DSH 未提供保存默认模型所需的服务')
  })

  it('retains an unavailable Host default without silently switching to another model', async () => {
    const api = mockApi({ ...connected(), selectedModelId: 'workbuddy/removed-model' })
    await render(api)
    expect(selector().value).toBe('workbuddy/removed-model')
    const unavailable = [...selector().options].find((option) => option.value === 'workbuddy/removed-model')!
    expect(unavailable.disabled).toBe(true)
    expect(unavailable.textContent).toContain('当前不可用')
    expect(api.selectModel).not.toHaveBeenCalled()
    await act(async () => { choose('qoder/model-b') })
    expect(api.selectModel).toHaveBeenCalledWith('qoder/model-b')
    expect(selector().value).toBe('qoder/model-b')
  })
})

describe('browser transport', () => {
  it('uses the host CSRF header and sends only the selected model ID', async () => {
    window.__DSH_CONNECT_AI_TOOLKIT_CSRF__ = 'csrf-test-token'
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => connected() })
    vi.stubGlobal('fetch', fetcher)
    await createHttpApi().selectModel('workbuddy/model-a')
    expect(fetcher).toHaveBeenCalledWith('/api/dsh-connect-ai-toolkit/model', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-DSH-AI-Toolkit-CSRF': 'csrf-test-token' },
      body: JSON.stringify({ modelId: 'workbuddy/model-a' }),
    }))
  })

  it('reports rejected HTTP operations instead of treating them as public state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: '请刷新页面后重试。' }) }))
    await expect(createHttpApi().refresh()).rejects.toThrow('请刷新页面后重试。')
  })
})
