import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const out = path.resolve(process.argv[2] || 'out')
const core = JSON.parse(fs.readFileSync('apps/core/package.json', 'utf8'))
// Resolve to the exact installed versions from the frozen workspace lockfile.
const versions = Object.fromEntries(['ws', 'loro-crdt'].map(name => [name,
  JSON.parse(fs.readFileSync(path.join('apps/core/node_modules', name, 'package.json'), 'utf8')).version,
]))
if (!core.dependencies['loro-crdt'] || !core.dependencies.ws) throw new Error('runtime dependency contract changed')
// sharp is normally lazy-installed; pin the site's tested standalone runtime.
versions.sharp = '0.35.5'
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: versions }, null, 2))
execFileSync('npm', ['install', '--prefix', out, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=true'], { stdio: 'inherit' })
