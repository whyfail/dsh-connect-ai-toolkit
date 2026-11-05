import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PROVIDER_ID } from './shared.js'
import { createLoopbackFetch, normalizeBaseURL } from './http.js'
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
      return {
        id: info.id,
        name: info.name,
        api: 'openai-completions',
        provider: PROVIDER_ID,
        baseUrl: settings.baseURL,
        input: override?.images === true ? ['text', 'image'] : ['text'],
        reasoning: false,
        contextWindow: override?.contextWindow ?? info.contextWindow ?? settings.contextWindow,
        maxTokens: override?.maxTokens ?? info.maxOutputTokens ?? settings.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: true,
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
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
  const adapter = new PiAiAdapter({
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
  })
  return { adapter, invalidate() { profiles = undefined } }
}
