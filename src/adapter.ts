import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ProviderStreams, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PROVIDER_ID } from './shared.js'
import type { GatewayModel } from './shared.js'
import { createLoopbackFetch, normalizeBaseURL } from './http.js'
import { displayedCreditRate, formatCreditRate } from './rate.js'
import type { ToolkitRuntime } from './runtime.js'

export interface AdapterRuntime {
  getState: ToolkitRuntime['getState']
  getSettings: ToolkitRuntime['getSettings']
  getApiKey: ToolkitRuntime['getApiKey']
}

const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('AI-Toolkit credentials are managed by the plugin runtime') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

// pi-ai's extended levels are the efforts this host can send. A platform may
// spell a tier differently (TRAE's catalog says `light` and `extra_high`), so
// known aliases map onto a host level and the platform's own word stays the
// value sent upstream.
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]

const LEVEL_ALIASES: Readonly<Record<string, ThinkingLevel>> = { light: 'low', extra_high: 'xhigh' }

interface ThinkingTier {
  level: ThinkingLevel
  effort: string
}

function thinkingTiers(model: GatewayModel): ThinkingTier[] {
  if (model.supportsReasoning === false) return []
  const tiers: ThinkingTier[] = []
  for (const option of model.reasoningEffortOptions ?? []) {
    const effort = option.trim().toLowerCase()
    const level = (THINKING_LEVELS as readonly string[]).includes(effort)
      ? effort as ThinkingLevel
      : LEVEL_ALIASES[effort]
    if (level === undefined || tiers.some(tier => tier.level === level)) continue
    tiers.push({ level, effort })
  }
  return tiers.sort((a, b) => THINKING_LEVELS.indexOf(a.level) - THINKING_LEVELS.indexOf(b.level))
}

function thinkingLevelMap(tiers: readonly ThinkingTier[]): ThinkingLevelMap {
  // Undeclared levels must be excluded explicitly: pi-ai treats an undefined entry
  // as selectable, which would send an effort the platform never offered.
  const map: ThinkingLevelMap = { off: null }
  for (const level of THINKING_LEVELS) {
    map[level] = tiers.find(tier => tier.level === level)?.effort ?? null
  }
  return map
}

/** A request-scoped fetch hook: it never changes the host's global fetch. */
export function gatewayFetch(baseURL: string, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  const normalized = normalizeBaseURL(baseURL)
  const expected = new URL(`${normalized}/chat/completions`)
  const guarded = createLoopbackFetch(normalized, fetchImpl)
  return async (input, init) => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    if (target.href !== expected.href || request.method !== 'POST') {
      throw new Error('AI-Toolkit inference cannot leave the configured chat endpoint')
    }
    return guarded(request, { redirect: 'error' })
  }
}

/** Preserve the SDK's protocol conversion while controlling its HTTP transport. */
function guardedProtocol(baseURL: string, fetchImpl?: typeof fetch): ProviderStreams {
  const api = openAICompletionsApi()
  const fetch = gatewayFetch(baseURL, fetchImpl)
  return {
    ...api,
    stream: (model, context, options) => api.stream(model, context, { ...options, fetch, maxRetries: 0 }),
    streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, fetch, maxRetries: 0 }),
  }
}

export function createToolkitAdapter(options: {
  runtime: AdapterRuntime
  fetch?: typeof fetch
  resolveAttachments?: () => AttachmentStore | undefined
}): { adapter: PiAiAdapter; invalidate(): void } {
  let profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const currentProfiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    if (profiles) return profiles
    const settings = options.runtime.getSettings()
    const models: Model<Api>[] = options.runtime.getState().models.map(info => {
      const override = Object.hasOwn(settings.overrides, info.id) ? settings.overrides[info.id] : undefined
      const tiers = thinkingTiers(info)
      return {
        id: info.id,
        name: info.name,
        api: 'openai-completions',
        provider: PROVIDER_ID,
        baseUrl: settings.baseURL,
        input: override?.images === true ? ['text', 'image'] : ['text'],
        // The catalog's declared tiers become the host's reasoning selector, and
        // each one travels upstream as the word the platform itself declared.
        reasoning: tiers.length > 0,
        ...(tiers.length > 0 ? { thinkingLevelMap: thinkingLevelMap(tiers) } : {}),
        contextWindow: override?.contextWindow ?? info.contextWindow ?? settings.contextWindow,
        maxTokens: override?.maxTokens ?? info.maxOutputTokens ?? settings.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: true,
          supportsDeveloperRole: true,
          supportsReasoningEffort: tiers.length > 0,
          supportsUsageInStreaming: true,
          maxTokensField: 'max_tokens',
          supportsStrictMode: false,
        },
      }
    })
    const piProvider = createProvider({
      id: PROVIDER_ID,
      name: 'AI-Toolkit（自动连接）',
      baseUrl: settings.baseURL,
      models,
      auth: {
        apiKey: {
          name: 'AI-Toolkit proxy API key',
          async resolve({ credential }) {
            return credential?.key ? { auth: { apiKey: credential.key } } : undefined
          },
        },
      },
      api: guardedProtocol(settings.baseURL, options.fetch),
    })
    const profile: ResolvedPiAiProviderProfile = {
      provider: PROVIDER_ID,
      displayName: 'AI-Toolkit（自动连接）',
      baseURL: settings.baseURL,
      streamIdleTimeoutMs: 300_000,
      maxRequestImageBytes: 20_971_520,
      maxRequestImages: 50,
      imageOffloadCountQuantum: 10,
      requestImagePixelBudget: 4_194_304,
      requestImageMaxBytes: 1_048_576,
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'AI-Toolkit retry policy'),
      configuredMaxTokens: new Map(models.map(model => [model.id, model.maxTokens])),
      modelErrors: new Map(),
      piProvider,
      transport: 'sse',
      cacheRetention: 'none',
    }
    profiles = new Map([[PROVIDER_ID, profile]])
    return profiles
  }
  const adapter = new ToolkitPiAdapter({
    profiles: currentProfiles,
    async resolveApiKey(_provider, profile) {
      try {
        return await options.runtime.getApiKey(profile.baseURL)
      } catch {
        throw new LlmError('请打开 AI-Toolkit 并开启本地代理，允许系统读取代理密钥。', 'MISSING_CREDENTIAL')
      }
    },
    auth: INERT_AUTH,
    ...(options.resolveAttachments ? { resolveAttachments: options.resolveAttachments } : {}),
  }, () => options.runtime.getState().models)
  return { adapter, invalidate() { profiles = undefined } }
}

/**
 * Adds the catalog's declared credit rate to every listed model. The model
 * picker renders it from `badge`, so the rate stays visible where a model is
 * chosen instead of only in the connection card.
 */
class ToolkitPiAdapter extends PiAiAdapter {
  private readonly catalog: () => GatewayModel[]

  constructor(config: PiAiAdapterOptions, catalog: () => GatewayModel[]) {
    super(config)
    this.catalog = catalog
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const rates = new Map(this.catalog().map(model => [model.id, model.creditRate]))
    return (await super.listModels(provider)).map(model => {
      const rate = rates.get(model.id)
      // A declared-but-unknown rate stays visible rather than implying 1×.
      const promotional = rate !== undefined && displayedCreditRate(rate).promotional
      return { ...model, badge: { text: formatCreditRate(rate), tone: promotional ? 'info' as const : 'neutral' as const } }
    })
  }
}
