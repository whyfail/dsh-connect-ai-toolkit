/** Browser-safe contract. No credentials may be added to these public types. */
export const PLUGIN_ID = 'dsh-connect-ai-toolkit'
// Keep the plugin route separate from users' pre-existing generic proxy profiles.
export const PROVIDER_ID = 'ai-toolkit-connect'
export const DEFAULT_BASE_URL = 'http://127.0.0.1:17860/v1'
export const DOWNLOAD_URL = 'https://github.com/whyfail/AI-Toolkit/releases/latest'
export const API_ROOT = '/api/dsh-connect-ai-toolkit'
export const DEFAULT_CONTEXT_WINDOW = 32_768
export const DEFAULT_MAX_TOKENS = 4_096

export interface ModelOverride {
  contextWindow?: number
  maxTokens?: number
  images?: boolean
}
export interface PluginSettings {
  baseURL: string
  contextWindow: number
  maxTokens: number
  overrides: Record<string, ModelOverride>
}
export interface GatewayModel {
  id: string
  name: string
  source: string
  contextWindow?: number
  maxOutputTokens?: number
}
export type ConnectionStatus = 'detecting' | 'connected' | 'missing' | 'offline' | 'credential-denied' | 'unsupported' | 'unauthorized'
export interface PublicState {
  models: GatewayModel[]
  status: ConnectionStatus
  selectedModelId: string | null
  canSelect: boolean
  lastSyncAt: number | null
  error: string | null
}
export interface ModelSelection {
  current(): { provider: string; model: string } | undefined
  available(): boolean
  save(modelId: string): Promise<void>
}
export function defaultSettings(): PluginSettings {
  return { baseURL: DEFAULT_BASE_URL, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, overrides: {} }
}
