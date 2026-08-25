import { handleTurn } from '../server/handler.ts'

/**
 * Vercel serverless adapter. Deliberately thin — all behaviour lives in
 * `handleTurn`, which knows nothing about the host.
 */
export const config = { runtime: 'nodejs' }

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: { code: 'bad_request', message: 'Use POST.', retryable: false } },
      { status: 405, headers: { allow: 'POST' } },
    )
  }

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: { code: 'bad_request', message: 'That request could not be read.', retryable: false } },
      { status: 400 },
    )
  }

  const result = await handleTurn(body)
  return Response.json(result.body, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  })
}
