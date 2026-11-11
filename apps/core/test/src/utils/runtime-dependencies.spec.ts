import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createRequire: vi.fn(), install: vi.fn() }))
vi.mock('node:module', async (original) => ({
  ...(await original<typeof import('node:module')>()),
  createRequire: mocks.createRequire,
}))
vi.mock('@antfu/install-pkg', () => ({ installPackage: mocks.install }))

import { requireDepsWithInstall } from '~/utils/tool.util'

describe('release runtime dependencies', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads bundled dependencies without invoking an installer', async () => {
    const require = Object.assign(vi.fn(() => 'bundled'), { resolve: vi.fn(() => '/release/node_modules/sharp') })
    mocks.createRequire.mockReturnValue(require)
    expect(await requireDepsWithInstall('sharp')).toBe('bundled')
    expect(mocks.createRequire).toHaveBeenCalledTimes(1)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('does not hide a broken bundled native binding with an install', async () => {
    const require = Object.assign(vi.fn(() => { throw new Error('native binding unavailable') }), { resolve: vi.fn(() => '/release/node_modules/sharp') })
    mocks.createRequire.mockReturnValue(require)
    await expect(requireDepsWithInstall('sharp')).rejects.toThrow('native binding unavailable')
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('retains existing shared-dependency fallback for older layouts', async () => {
    const missing = Object.assign(vi.fn(), { resolve: vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' }) }) })
    const shared = Object.assign(vi.fn(() => 'shared'), { resolve: vi.fn(() => '/shared/sharp') })
    mocks.createRequire.mockReturnValueOnce(missing).mockReturnValue(shared)
    expect(await requireDepsWithInstall('sharp')).toBe('shared')
    expect(mocks.install).not.toHaveBeenCalled()
  })
})
