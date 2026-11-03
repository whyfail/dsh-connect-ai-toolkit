export type CredentialFailureCode = 'missing' | 'credential-denied' | 'unsupported' | 'unauthorized'
type Failure = { ok: false; code: CredentialFailureCode; message: string }
export type CredentialSourceResult = { ok: true; key: string } | Failure
export interface CredentialLease { scope: string; generation: number; fresh: boolean }
export type CredentialResult = ({ ok: true; key: string } & CredentialLease) | Failure

interface Session {
  key: string | null
  generation: number
  validated?: boolean
  pending?: Promise<CredentialResult>
  blocked?: Failure
}

// DSH may stop and re-apply a plugin during installation. Module-local state
// cannot coalesce those instances, and native reads can outlive their runtime.
const registryKey = Symbol.for('dsh-connect-ai-toolkit.credential-session.v1')
const host = globalThis as unknown as Record<symbol, Map<string, Session> | undefined>
const sessions = host[registryKey] ??= new Map()

/** Only the proxy key and plain, sanitized outcomes survive module hot reload. */
export function readSharedCredential(
  scope: string,
  source: () => Promise<CredentialSourceResult>,
  options: { retry?: boolean; rejectedGeneration?: number } = {},
): Promise<CredentialResult> {
  let session = sessions.get(scope)
  if (!session) { session = { key: null, generation: 0 }; sessions.set(scope, session) }
  const state = session
  if (state.pending) return state.pending
  if (options.retry) state.blocked = undefined
  if (state.blocked) return Promise.resolve(state.blocked)
  // A stale runtime's 401 must not prompt again after another instance refreshed.
  if (state.key && options.rejectedGeneration !== state.generation) {
    return Promise.resolve({ ok: true, key: state.key, scope, generation: state.generation, fresh: false })
  }
  const pending = Promise.resolve().then(source).catch((): Failure => ({
    ok: false, code: 'credential-denied', message: '无法读取 AI-Toolkit 代理密钥，请允许系统凭据授权后重试。',
  })).then((result): CredentialResult => {
    if (!result.ok) {
      state.key = null
      state.validated = false
      // Even a missing proxy entry may follow an authorized shared-vault read.
      // Do not repeat that interactive lookup on the background polling timer.
      state.blocked = result
      return result
    }
    state.key = result.key
    state.validated = false
    state.blocked = undefined
    return { ok: true, key: result.key, scope, generation: ++state.generation, fresh: true }
  }).finally(() => { if (state.pending === pending) state.pending = undefined })
  // Publish the promise before source() runs, including synchronous failures.
  state.pending = pending
  return pending
}

/** A rejected current generation stays paused across newly-created runtimes. */
export function rejectSharedCredential(lease: CredentialLease): void {
  const state = sessions.get(lease.scope)
  if (!state || state.generation !== lease.generation) return
  state.key = null
  state.validated = false
  state.blocked = { ok: false, code: 'unauthorized', message: '代理密钥无效，请在 AI-Toolkit 中检查代理后点击下拉框重试。' }
}

/** A completed source read is not proof that this key has ever authenticated. */
export function confirmSharedCredential(lease: CredentialLease): void {
  const state = sessions.get(lease.scope)
  if (state?.key && state.generation === lease.generation) state.validated = true
}

export function canRecoverSharedCredential(lease: CredentialLease): boolean {
  const state = sessions.get(lease.scope)
  // An older runtime may join a newer generation without another source read.
  return !!state && (state.generation !== lease.generation || state.validated === true)
}
