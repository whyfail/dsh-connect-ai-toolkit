import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('Harness plugin compatibility gate', () => {
  it.each(['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'])('accepts supported DSH %s without an exemption', version => {
    expect(evaluatePluginCompatibility(manifest, {}, version)).toBeUndefined()
  })

  it.each(['0.2.1-rc.4', '0.2.2-rc.2', '0.3.0'])('keeps unverified DSH %s behind the compatibility gate', version => {
    expect(evaluatePluginCompatibility(manifest, {}, version)).toMatchObject({
      name: manifest.name, version: manifest.version, runtimeVersion: version, exempted: false,
    })
  })
})
