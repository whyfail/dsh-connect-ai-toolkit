import { API_ROOT, type PublicState } from '../shared.ts'

declare global {
  interface Window { __DSH_CONNECT_AI_TOOLKIT_CSRF__?: string }
}

export interface ToolkitApi {
  getState(): Promise<PublicState>
  selectModel(modelId: string): Promise<PublicState>
  refresh(): Promise<PublicState>
}

/** Calls the current DSH host; connection credentials never reach the browser. */
export function createHttpApi(): ToolkitApi {
  async function request(path: string, body?: unknown): Promise<PublicState> {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-DSH-AI-Toolkit-CSRF': window.__DSH_CONNECT_AI_TOOLKIT_CSRF__ ?? '',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null)
      throw new Error(payload !== null && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error : `请求失败（HTTP ${response.status}）`)
    }
    return response.json() as Promise<PublicState>
  }
  return {
    getState: () => request('/state'),
    selectModel: (modelId) => request('/model', { modelId }),
    refresh: () => request('/refresh', {}),
  }
}
