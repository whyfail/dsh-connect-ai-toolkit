import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { PLUGIN_ID } from '../shared.ts'
import { ToolkitCard } from './ToolkitCard.tsx'

export const name = `${PLUGIN_ID}-client`
export const inject = ['slots']

type ConfigView = { view: 'summary' | 'page' }
type ConfigSlot = 'plugins.bundle.config' | 'plugins.row.config'
/** The plugin-manager seats are declared at runtime; no runtime dependency on its implementation. */
interface PluginConfigSlots {
  inject(name: ConfigSlot, register: () => () => void): () => void
  register(options: { name: ConfigSlot; key: string; priority: number }, component: ComponentType<ConfigView>): () => void
}

function ToolkitConfig({ view }: ConfigView) {
  return view === 'summary' ? <span>连接 AI-Toolkit 本地代理，自动同步全部可用模型。</span> : <ToolkitCard />
}

/** Register under Plugins → DSH Connect AI-Toolkit → Configuration. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: PluginConfigSlots }).slots
  for (const slot of ['plugins.bundle.config', 'plugins.row.config'] as const) {
    try {
      const key = slot === 'plugins.row.config' ? `${PLUGIN_ID}#${PLUGIN_ID}` : PLUGIN_ID
      ctx.effect(() => slots.inject(slot, () => slots.register({ name: slot, key, priority: 30 }, ToolkitConfig)), `${PLUGIN_ID}: ${slot}`)
    } catch {
      // A changed client seat must not prevent the independent model provider from running.
      console.error(`[${PLUGIN_ID}] 无法注册配置界面 ${slot}；请检查 DSH 版本兼容性。`)
    }
  }
}
