import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-config-editor'
import { PROVIDER_ID, type ModelSelection } from './shared.ts'

/** Saves the actual DSH deployment default, rather than a plugin-only preference. */
export function createModelSelection(ctx: Context): ModelSelection {
  function services() {
    return { defaults: ctx.get('agentDefaultModel'), editor: ctx.get('configEditor'), llm: ctx.get('llm') }
  }
  return {
    current() {
      try {
        const current = services().defaults?.currentSelection()
        return current ? { provider: current.provider, model: current.model } : undefined
      } catch { return undefined }
    },
    available() {
      const { defaults, editor, llm } = services()
      return defaults !== undefined && editor !== undefined && llm !== undefined
    },
    async save(modelId) {
      const { defaults, editor, llm } = services()
      if (!defaults || !editor || !llm) throw new Error('当前 DSH 不支持保存新会话默认模型，请启用默认模型和配置编辑服务。')
      const resolved = await llm.resolveCallConfig({ provider: PROVIDER_ID, model: modelId })
      if (resolved.provider !== PROVIDER_ID || resolved.model !== modelId) throw new Error('DSH 返回的模型身份与选择不一致。')
      await defaults.saveSelection({ provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) })
      const confirmed = services().defaults?.currentSelection()
      if (confirmed?.provider !== PROVIDER_ID || confirmed.model !== modelId) throw new Error('DSH 未保存所选默认模型，请检查当前配置是否可写。')
    },
  }
}
