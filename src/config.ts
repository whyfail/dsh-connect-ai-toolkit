import { mkdir, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { defaultSettings, type GatewayModel, type PluginSettings, type ModelOverride } from './shared.ts'
import { normalizeBaseURL, parseModels } from './http.ts'

export interface SavedConfig { version: 1; settings: PluginSettings; models: GatewayModel[]; lastSyncAt: number | null; rememberKey?: boolean }
export function pluginDirectory(): string { return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-connect-ai-toolkit') }
function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是正整数。`)
  return value
}
export function validateSettings(raw: unknown): PluginSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('设置格式不正确。')
  const input = raw as Record<string, unknown>
  const baseURL = normalizeBaseURL(String(input.baseURL ?? ''))
  const contextWindow = integer(input.contextWindow, '上下文预算')
  const maxTokens = integer(input.maxTokens, '输出预算')
  if (maxTokens > contextWindow) throw new Error('输出预算不能大于上下文预算。')
  if (!input.overrides || typeof input.overrides !== 'object' || Array.isArray(input.overrides)) throw new Error('单模型设置格式不正确。')
  const overrides: Record<string, ModelOverride> = Object.create(null)
  for (const [id, value] of Object.entries(input.overrides)) {
    if (!id.trim() || id.length > 1024 || /[\u0000-\u001f\u007f]/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('单模型设置包含无效条目。')
    const row = value as Record<string, unknown>
    const entry: ModelOverride = {}
    if (row.contextWindow !== undefined) entry.contextWindow = integer(row.contextWindow, '模型上下文预算')
    if (row.maxTokens !== undefined) entry.maxTokens = integer(row.maxTokens, '模型输出预算')
    if (row.images !== undefined) {
      if (typeof row.images !== 'boolean') throw new Error('图片开关必须是布尔值。')
      entry.images = row.images
    }
    if ((entry.maxTokens ?? maxTokens) > (entry.contextWindow ?? contextWindow)) throw new Error('模型输出预算不能大于其上下文预算。')
    overrides[id] = entry
  }
  // Explicit projection: accidentally submitted API keys or other fields are never persisted.
  return { baseURL, contextWindow, maxTokens, overrides }
}
export class ConfigStore {
  constructor(public readonly directory = pluginDirectory()) {}
  async load(): Promise<SavedConfig> {
    const fallback: SavedConfig = { version: 1, settings: defaultSettings(), models: [], lastSyncAt: null, rememberKey: false }
    const path = join(this.directory, 'config.json')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('插件配置文件无效。')
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (value.version !== 1) throw new Error('插件配置版本不兼容。')
      const settings = validateSettings(value.settings)
      const models = Array.isArray(value.models) ? parseModels({ data: value.models.map((m: GatewayModel) => ({ id: m.id, name: m.name, owned_by: m.source })) }) : []
      return { version: 1, settings, models, lastSyncAt: typeof value.lastSyncAt === 'number' && Number.isFinite(value.lastSyncAt) ? value.lastSyncAt : null, rememberKey: value.rememberKey !== false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw error
    }
  }
  async save(value: SavedConfig): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('插件配置目录无效。')
    const path = join(this.directory, 'config.json')
    const temporary = join(this.directory, `.config-${randomUUID()}.tmp`)
    try {
      const safe = { version: 1, settings: validateSettings(value.settings), models: value.models.map(({ id, name, source }) => ({ id, name, source })), lastSyncAt: value.lastSyncAt, rememberKey: value.rememberKey === true }
      await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => {}) }
  }
}
