import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'dsh-toolkit-package-'))
try {
  // Install the actual distributable with its declared peers, without running lifecycle scripts.
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'Run this check with npm run test:package')
  const result = spawnSync(process.execPath, [npmCli, 'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', join(root, `${name}-${version}.tgz`)], { stdio: 'inherit' })
  assert.equal(result.status, 0, 'The tarball must install successfully')
  const module = await import(pathToFileURL(join(directory, 'node_modules', name, 'lib/index.js')).href)
  assert.equal(module.name, name)
  assert.equal(typeof module.apply, 'function')
  const client = await readFile(join(directory, 'node_modules', name, 'lib/client.js'), 'utf8')
  assert.match(client, /__ModuleLoader__\.load/)
  assert.ok(!client.includes('node:keychain') && !client.includes('@napi-rs/keyring'), 'No native credential code in browser bundle')
  const metadata = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'))
  assert.equal(metadata.icon, 'icons/ai-toolkit.png', 'The host must receive the Toolkit package icon')
  const icon = await readFile(join(directory, 'node_modules', name, metadata.icon))
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.ok(icon.length < 256 * 1024, 'The icon must fit the host metadata limit')
  assert.match(client, /data:image\/png/)
  assert.match(client, /data:image\/svg\+xml/)
  console.log('Installed package: host entry and browser module loader verified.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
