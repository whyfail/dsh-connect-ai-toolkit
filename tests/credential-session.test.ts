import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { CredentialSourceResult } from '../src/credential-session.js'

const loadSession = () => import('../src/credential-session.js')
const newScope = () => `test:${randomUUID()}`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('process-wide credential session', () => {
  it('coalesces concurrent source reads before the source starts', async () => {
    const { readSharedCredential } = await loadSession()
    const scope = newScope()
    const gate = deferred<CredentialSourceResult>()
    const source = vi.fn(() => gate.promise)

    const reads = Array.from({ length: 8 }, () => readSharedCredential(scope, source))
    expect(reads.every(read => read === reads[0])).toBe(true)
    await Promise.resolve()
    expect(source).toHaveBeenCalledTimes(1)

    gate.resolve({ ok: true, key: 'fake-proxy-key' })
    expect(await Promise.all(reads)).toEqual(Array.from({ length: 8 }, () => ({
      ok: true, key: 'fake-proxy-key', scope, generation: 1, fresh: true,
    })))
  })

  it('reuses a successful key without reading the source again', async () => {
    const { readSharedCredential } = await loadSession()
    const scope = newScope()
    const source = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'fake-cached-key' }))

    const first = await readSharedCredential(scope, source)
    const cached = await readSharedCredential(scope, source)

    expect(first).toEqual({ ok: true, key: 'fake-cached-key', scope, generation: 1, fresh: true })
    expect(cached).toEqual({ ok: true, key: 'fake-cached-key', scope, generation: 1, fresh: false })
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('keeps pending reads and successful keys across module hot reload', async () => {
    const firstModule = await loadSession()
    const scope = newScope()
    const gate = deferred<CredentialSourceResult>()
    const source = vi.fn(() => gate.promise)
    const first = firstModule.readSharedCredential(scope, source)
    await Promise.resolve()
    expect(source).toHaveBeenCalledTimes(1)

    vi.resetModules()
    const secondModule = await loadSession()
    const unexpectedSource = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'unexpected-key' }))
    const second = secondModule.readSharedCredential(scope, unexpectedSource)
    expect(second).toBe(first)

    gate.resolve({ ok: true, key: 'fake-hmr-key' })
    const result = await second
    expect(result).toEqual({ ok: true, key: 'fake-hmr-key', scope, generation: 1, fresh: true })

    vi.resetModules()
    const thirdModule = await loadSession()
    expect(await thirdModule.readSharedCredential(scope, unexpectedSource)).toEqual({
      ok: true, key: 'fake-hmr-key', scope, generation: 1, fresh: false,
    })
    expect(unexpectedSource).not.toHaveBeenCalled()
  })

  it('remembers denied authorization across hot reload and coalesces manual retries', async () => {
    const firstModule = await loadSession()
    const scope = newScope()
    const denied: CredentialSourceResult = {
      ok: false, code: 'credential-denied', message: 'Test authorization was declined.',
    }
    const source = vi.fn(async () => denied)
    expect(await firstModule.readSharedCredential(scope, source)).toEqual(denied)

    vi.resetModules()
    const secondModule = await loadSession()
    const retryGate = deferred<CredentialSourceResult>()
    const retrySource = vi.fn(() => retryGate.promise)
    expect(await secondModule.readSharedCredential(scope, retrySource)).toEqual(denied)
    expect(retrySource).not.toHaveBeenCalled()

    const retry = secondModule.readSharedCredential(scope, retrySource, { retry: true })
    const duplicateRetry = secondModule.readSharedCredential(scope, retrySource, { retry: true })
    const backgroundRead = firstModule.readSharedCredential(scope, source)
    expect(duplicateRetry).toBe(retry)
    expect(backgroundRead).toBe(retry)
    await Promise.resolve()
    expect(retrySource).toHaveBeenCalledTimes(1)
    expect(source).toHaveBeenCalledTimes(1)

    retryGate.resolve({ ok: true, key: 'fake-retry-key' })
    expect(await retry).toEqual({ ok: true, key: 'fake-retry-key', scope, generation: 1, fresh: true })
    expect(await secondModule.readSharedCredential(scope, retrySource)).toEqual({
      ok: true, key: 'fake-retry-key', scope, generation: 1, fresh: false,
    })
    expect(retrySource).toHaveBeenCalledTimes(1)
  })

  it('isolates pending, cached, and denied credentials belonging to different scopes', async () => {
    const { readSharedCredential, rejectSharedCredential } = await loadSession()
    const firstScope = newScope()
    const secondScope = newScope()
    const gate = deferred<CredentialSourceResult>()
    const firstSource = vi.fn(() => gate.promise)
    const secondSource = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'fake-second-key' }))

    const pendingFirst = readSharedCredential(firstScope, firstSource)
    const second = await readSharedCredential(secondScope, secondSource)
    expect(second).toEqual({ ok: true, key: 'fake-second-key', scope: secondScope, generation: 1, fresh: true })
    expect(firstSource).toHaveBeenCalledTimes(1)

    gate.resolve({ ok: true, key: 'fake-first-key' })
    const first = await pendingFirst
    expect(first).toEqual({ ok: true, key: 'fake-first-key', scope: firstScope, generation: 1, fresh: true })
    if (!first.ok) throw new Error('Expected a successful fake credential')
    rejectSharedCredential(first)

    expect(await readSharedCredential(firstScope, firstSource)).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(await readSharedCredential(secondScope, secondSource)).toEqual({
      ok: true, key: 'fake-second-key', scope: secondScope, generation: 1, fresh: false,
    })
    expect(firstSource).toHaveBeenCalledTimes(1)
    expect(secondSource).toHaveBeenCalledTimes(1)
  })

  it('refreshes one rejected generation once for concurrent runtimes', async () => {
    const { readSharedCredential } = await loadSession()
    const scope = newScope()
    const first = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-old-key' }))
    if (!first.ok) throw new Error('Expected a successful fake credential')
    const gate = deferred<CredentialSourceResult>()
    const refreshSource = vi.fn(() => gate.promise)

    const refreshes = Array.from({ length: 6 }, () => readSharedCredential(scope, refreshSource, {
      rejectedGeneration: first.generation,
    }))
    expect(refreshes.every(refresh => refresh === refreshes[0])).toBe(true)
    await Promise.resolve()
    expect(refreshSource).toHaveBeenCalledTimes(1)

    gate.resolve({ ok: true, key: 'fake-rotated-key' })
    const results = await Promise.all(refreshes)
    expect(results).toEqual(Array.from({ length: 6 }, () => ({
      ok: true, key: 'fake-rotated-key', scope, generation: 2, fresh: true,
    })))
  })

  it('gives a stale runtime the refreshed key without another source authorization', async () => {
    const { readSharedCredential } = await loadSession()
    const scope = newScope()
    const first = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-old-key' }))
    if (!first.ok) throw new Error('Expected a successful fake credential')
    const refreshed = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-new-key' }), {
      rejectedGeneration: first.generation,
    })
    expect(refreshed).toEqual({ ok: true, key: 'fake-new-key', scope, generation: 2, fresh: true })
    const unexpectedSource = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'unexpected-key' }))

    expect(await readSharedCredential(scope, unexpectedSource, { rejectedGeneration: first.generation })).toEqual({
      ok: true, key: 'fake-new-key', scope, generation: 2, fresh: false,
    })
    expect(unexpectedSource).not.toHaveBeenCalled()
  })

  it('pauses a rejected current generation across hot reload until an explicit retry', async () => {
    const firstModule = await loadSession()
    const scope = newScope()
    const first = await firstModule.readSharedCredential(scope, async () => ({ ok: true, key: 'fake-rejected-key' }))
    if (!first.ok) throw new Error('Expected a successful fake credential')
    firstModule.rejectSharedCredential(first)

    vi.resetModules()
    const secondModule = await loadSession()
    const source = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'fake-recovery-key' }))
    const blocked = await secondModule.readSharedCredential(scope, source)
    expect(blocked).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(JSON.stringify(blocked)).not.toContain('fake-rejected-key')
    expect(source).not.toHaveBeenCalled()

    expect(await secondModule.readSharedCredential(scope, source, { retry: true })).toEqual({
      ok: true, key: 'fake-recovery-key', scope, generation: 2, fresh: true,
    })
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('does not let a late rejection of an old generation erase the newer key', async () => {
    const { readSharedCredential, rejectSharedCredential } = await loadSession()
    const scope = newScope()
    const first = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-old-key' }))
    if (!first.ok) throw new Error('Expected a successful fake credential')
    const second = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-current-key' }), {
      rejectedGeneration: first.generation,
    })
    if (!second.ok) throw new Error('Expected a successful fake credential')
    rejectSharedCredential(first)
    const unexpectedSource = vi.fn(async (): Promise<CredentialSourceResult> => ({ ok: true, key: 'unexpected-key' }))

    expect(await readSharedCredential(scope, unexpectedSource)).toEqual({
      ok: true, key: 'fake-current-key', scope, generation: second.generation, fresh: false,
    })
    expect(unexpectedSource).not.toHaveBeenCalled()
  })

  it('requires authentication of the current generation before automatic source recovery', async () => {
    const { readSharedCredential, confirmSharedCredential, canRecoverSharedCredential } = await loadSession()
    const scope = newScope()
    const first = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-unverified-key' }))
    if (!first.ok) throw new Error('Expected a successful fake credential')
    const cached = await readSharedCredential(scope, async () => ({ ok: true, key: 'unexpected-key' }))
    if (!cached.ok) throw new Error('Expected a cached fake credential')
    expect(cached.fresh).toBe(false)
    expect(canRecoverSharedCredential(cached)).toBe(false)
    confirmSharedCredential(first)
    expect(canRecoverSharedCredential(cached)).toBe(true)

    const rotated = await readSharedCredential(scope, async () => ({ ok: true, key: 'fake-next-key' }), {
      rejectedGeneration: first.generation,
    })
    if (!rotated.ok) throw new Error('Expected a rotated fake credential')
    confirmSharedCredential(first)
    expect(canRecoverSharedCredential(rotated)).toBe(false)
    expect(canRecoverSharedCredential(first)).toBe(true)
    confirmSharedCredential(rotated)
    expect(canRecoverSharedCredential(rotated)).toBe(true)
  })

  it.each(['throw', 'reject'] as const)('sanitizes an unexpected native %s and prevents background retries', async mode => {
    const { readSharedCredential } = await loadSession()
    const scope = newScope()
    const sensitiveDetail = 'fake-native-secret-and-private-path'
    const source = vi.fn((): Promise<CredentialSourceResult> => {
      const error = new Error(`Native credential error: ${sensitiveDetail}`)
      if (mode === 'throw') throw error
      return Promise.reject(error)
    })
    const result = await readSharedCredential(scope, source)

    expect(result).toMatchObject({ ok: false, code: 'credential-denied' })
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail)
    expect(JSON.stringify(result)).not.toContain('Native credential error')
    expect(await readSharedCredential(scope, source)).toEqual(result)
    expect(source).toHaveBeenCalledTimes(1)
  })
})
