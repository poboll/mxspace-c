import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(cliRoot, '..', '..', 'apps', 'admin', 'dist-author')
const to = join(cliRoot, 'dist', 'vendor', 'author')

if (!existsSync(join(from, 'index.html'))) {
  console.error(
    'missing apps/admin/dist-author/index.html — run `pnpm -C apps/admin run build:author`',
  )
  process.exit(1)
}

mkdirSync(dirname(to), { recursive: true })
cpSync(from, to, { recursive: true })
