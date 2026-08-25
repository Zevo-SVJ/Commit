import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleTurn } from './handler.ts'

/** Shared Node HTTP glue for the dev server and the standalone server. */

const MAX_BODY = 64 * 1024

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function serveDecision(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'Use POST.', retryable: false } }))
    return
  }

  let body: unknown
  try {
    body = await readJson(req)
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: { code: 'bad_request', message: 'That request could not be read.', retryable: false },
      }),
    )
    return
  }

  const result = await handleTurn(body)
  res.writeHead(result.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(result.body))
}
