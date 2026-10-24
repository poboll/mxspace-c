import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

import { makeTmpHome } from './_helpers'

const bin = process.env.MXS_TEST_BIN ?? fileURLToPath(new URL('../../src/bin/mxs.ts', import.meta.url))

it('sends nested draft writes and uses the current revision for updates and dry runs', async () => {
  const cleanup = makeTmpHome()
  const writes: Array<{ method: string; body: any }> = []
  const content = JSON.stringify({ root: { type: 'root', children: [] } })
  const branch = {
    id: 'branch-1',
    document: { id: 'document-1', ref_type: 'post' },
    head_revision_id: 'revision-1',
    head_revision: {
      id: 'revision-1',
      title: 'Original',
      text: '',
      content,
      content_format: 'lexical',
      type_specific_data: { slug: 'original', tags: ['keep'] },
    },
  }
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: req.url?.endsWith('/drafts/branch-1')
        ? branch
        : { name: 'mx-server', version: '3.0.0' } }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    writes.push({ method: req.method!, body })
    const valid = body.data && !('title' in body) &&
      (req.method === 'POST' ? body.refType === 'post' : body.expectedHeadRevisionId === 'revision-1')
    res.statusCode = valid ? 200 : 422
    res.end(JSON.stringify(valid ? { data: branch } : { message: 'invalid draft envelope' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`
  const run = (args: string[]) => new Promise<any>((resolve, reject) => {
    const child = spawn('npx', ['tsx', bin, '--api-url', url, '--output', 'json', ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${code}: ${stderr}\n${stdout}`))
      else {
        try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) }
      }
    })
  })
  try {
    const create = ['draft', 'create', '--title', 'New', '--content', '<p>Hello</p>']
    await run(create)
    expect(writes[0]?.body.data.title).toBe('New')
    expect(JSON.parse(writes[0]?.body.data.content).root.children[0].type).toBe('paragraph')
    const preview = await run(['--dry-run', ...create])
    expect(preview.data.data.body).toEqual(writes[0]?.body)
    expect(writes).toHaveLength(1)

    const update = ['draft', 'update', 'branch-1', '--title', 'Updated']
    await run(update)
    expect(writes[1]?.body.data).toMatchObject({
      title: 'Updated', content,
      typeSpecificData: { slug: 'original', tags: ['keep'] },
    })
    const updatePreview = await run(['--dry-run', ...update])
    expect(updatePreview.data.data.body).toEqual(writes[1]?.body)
    expect(writes).toHaveLength(2)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    cleanup()
  }
}, 60_000)
