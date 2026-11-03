import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createModelSelection } from '../src/selection.ts'
import { PROVIDER_ID } from '../src/shared.ts'

function fixture() {
  let selected = { provider: 'deepseek', model: 'original-model' }
  const defaults = {
    currentSelection: vi.fn(() => selected),
    saveSelection: vi.fn(async (next: typeof selected) => { selected = next }),
  }
  const llm = { resolveCallConfig: vi.fn(async (input: typeof selected) => input) }
  const services: Record<string, unknown> = { agentDefaultModel: defaults, configEditor: {}, llm }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  return { bridge: createModelSelection(ctx), defaults, llm, services }
}

describe('real DSH default-model bridge', () => {
  it('resolves and persists the requested route, then confirms the Host selection', async () => {
    const { bridge, defaults, llm } = fixture()
    expect(bridge.available()).toBe(true)
    await bridge.save('workbuddy/model-a')
    expect(llm.resolveCallConfig).toHaveBeenCalledWith({ provider: PROVIDER_ID, model: 'workbuddy/model-a' })
    expect(defaults.saveSelection).toHaveBeenCalledWith({ provider: PROVIDER_ID, model: 'workbuddy/model-a' })
    expect(bridge.current()).toEqual({ provider: PROVIDER_ID, model: 'workbuddy/model-a' })
  })

  it('refuses a missing config editor before invoking the no-op save API', async () => {
    const { bridge, defaults, llm, services } = fixture()
    delete services.configEditor
    expect(bridge.available()).toBe(false)
    await expect(bridge.save('model-a')).rejects.toThrow('不支持保存新会话默认模型')
    expect(defaults.saveSelection).not.toHaveBeenCalled()
    expect(llm.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('reports a silently ineffective save instead of recording an unused preference', async () => {
    const { bridge, defaults } = fixture()
    defaults.saveSelection.mockImplementation(async () => {})
    await expect(bridge.save('model-a')).rejects.toThrow('DSH 未保存所选默认模型')
    expect(bridge.current()).toEqual({ provider: 'deepseek', model: 'original-model' })
  })

  it('propagates a model resolution failure without changing the default', async () => {
    const { bridge, defaults, llm } = fixture()
    llm.resolveCallConfig.mockRejectedValue(new Error('模型不可用'))
    await expect(bridge.save('model-a')).rejects.toThrow('模型不可用')
    expect(defaults.saveSelection).not.toHaveBeenCalled()
  })

  it('rejects a route identity mismatch before saving', async () => {
    const { bridge, defaults, llm } = fixture()
    llm.resolveCallConfig.mockResolvedValue({ provider: 'another-provider', model: 'model-a' })
    await expect(bridge.save('model-a')).rejects.toThrow('模型身份与选择不一致')
    expect(defaults.saveSelection).not.toHaveBeenCalled()
  })

  it('returns a detached current selection and handles an absent default service', () => {
    const { bridge, services } = fixture()
    const current = bridge.current()!
    current.model = 'changed-by-reader'
    expect(bridge.current()?.model).toBe('original-model')
    delete services.agentDefaultModel
    expect(bridge.current()).toBeUndefined()
    expect(bridge.available()).toBe(false)
  })
})
