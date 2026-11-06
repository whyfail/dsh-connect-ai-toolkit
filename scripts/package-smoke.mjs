import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const root = resolve(import.meta.dirname, '..')
const { name, version, peerDependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const sdkVersion = process.env.DSH_TEST_VERSION ?? '0.2.2-rc.1'
assert.ok(['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'].includes(sdkVersion), 'Select a supported SDK version')
const directory = await mkdtemp(join(tmpdir(), 'dsh-toolkit-package-'))
try {
  // Install the actual distributable with its declared peers, without running lifecycle scripts.
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'Run this check with npm run test:package')
  const sdkPeers = Object.keys(peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-')).map(name => `${name}@${sdkVersion}`)
  const result = spawnSync(process.execPath, [npmCli, 'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', join(root, `${name}-${version}.tgz`), ...sdkPeers], { stdio: 'inherit' })
  assert.equal(result.status, 0, 'The tarball must install successfully')
  const module = await import(pathToFileURL(join(directory, 'node_modules', name, 'lib/index.js')).href)
  assert.equal(module.name, name)
  assert.equal(typeof module.apply, 'function')
  const client = await readFile(join(directory, 'node_modules', name, 'lib/client.js'), 'utf8')
  assert.match(client, /__ModuleLoader__\.load/)
  assert.ok(!client.includes('node:keychain') && !client.includes('@napi-rs/keyring'), 'No native credential code in browser bundle')
  const metadata = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'))
  const installedRequire = createRequire(join(directory, 'package.json'))
  const sdk = JSON.parse(await readFile(installedRequire.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8'))
  assert.equal(sdk.version, sdkVersion, 'Check the selected SDK rather than an auto-selected peer')
  assert.equal(evaluatePluginCompatibility(metadata, {}, sdk.version), undefined, 'The real Harness compatibility gate must accept the package without an exemption')
  assert.equal(metadata.icon, 'icons/ai-toolkit.png', 'The host must receive the Toolkit package icon')
  const icon = await readFile(join(directory, 'node_modules', name, metadata.icon))
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(icon.length < 256 * 1024, 'The icon must fit the host metadata limit')
  assert.match(client, /data:image\/png/)
  assert.match(client, /data:image\/svg\+xml/)
  console.log(`Installed package: DSH ${sdkVersion} compatibility, host entry and browser module loader verified.`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
