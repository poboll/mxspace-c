import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Generic } from '../../domain/errors'

export const AUTHOR_PORT_START = 4173

export function findCliPackageRoot(fromUrl: string): string | null {
  let dir = dirname(fileURLToPath(fromUrl))
  for (let i = 0; i < 8; i++) {
    if (!dir || dir === dirname(dir)) break
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as {
        name?: string
      }
      if (pkg.name === '@mx-space/cli') return dir
    } catch {
      dir = dirname(dir)
      continue
    }
    dir = dirname(dir)
  }
  return null
}

export function isAuthorSourceModule(fromUrl: string): boolean {
  return /[/\\]src[/\\]cli[/\\]author[/\\]/.test(fileURLToPath(fromUrl))
}

export function resolveAuthorSpaDir(
  cliRoot: string,
  fromSource: boolean,
): string {
  const vendored = join(cliRoot, 'dist', 'vendor', 'author')
  if (existsSync(join(vendored, 'index.html'))) return vendored
  if (fromSource) {
    const admin = join(cliRoot, '..', '..', 'apps', 'admin', 'dist-author')
    if (existsSync(join(admin, 'index.html'))) return admin
    throw new Generic({
      message: 'cannot resolve mxs author editor',
      hint: 'run `pnpm -C apps/admin run build:author` then retry',
    })
  }
  throw new Generic({
    message: 'cannot resolve mxs author editor',
    hint: 'reinstall @mx-space/cli so dist/vendor/author is present',
  })
}

export function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

export async function pickAuthorPort(preferred?: number): Promise<number> {
  if (preferred !== undefined) {
    const free = await canListen(preferred)
    if (!free) {
      throw new Generic({
        message: `port ${preferred} is in use`,
        hint: 'pass a free --port or omit it to pick one automatically',
      })
    }
    return preferred
  }
  for (let port = AUTHOR_PORT_START; port < AUTHOR_PORT_START + 50; port++) {
    if (await canListen(port)) return port
  }
  return 0
}
