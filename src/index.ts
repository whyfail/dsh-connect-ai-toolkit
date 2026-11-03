import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import { createToolkitAdapter } from './adapter.js'
import { ToolkitRuntime } from './runtime.js'
import { PROVIDER_ID } from './shared.js'
import { registerToolkitWeb } from './web.js'
import { createModelSelection } from './selection.js'

export const name = 'dsh-connect-ai-toolkit'
export const inject = ['llm', 'webServer']

/** The plugin owns its runtime; it never modifies AI-Toolkit or host credentials. */
export function apply(ctx: Context): void {
  const runtime = new ToolkitRuntime({ selection: createModelSelection(ctx) })
  ctx.effect(() => () => runtime.dispose())
  const { adapter, invalidate } = createToolkitAdapter({
    runtime,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter))
  ctx.effect(() => runtime.subscribe(() => {
    invalidate()
    ctx.emit('llm/adapters-updated')
  }))
  ctx.effect(() => registerToolkitWeb(ctx, runtime))
  // An OS authorization dialog must not block plugin activation or its UI.
  void runtime.start().catch(() => {})
}
