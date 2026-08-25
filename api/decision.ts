/**
 * Vercel serverless adapter.
 *
 * Written defensively on purpose. When this function fails to run at all, the
 * platform answers with an HTML error or the SPA fallback, the browser cannot
 * parse it, and every distinct failure looks identical from the outside. So:
 *
 *  - it accepts both the Node (req, res) and the Web (Request) signatures,
 *    because which one a runtime hands you is not worth guessing;
 *  - it loads the handler with a dynamic import inside a try, so a module that
 *    fails to resolve returns a readable JSON error instead of a crash;
 *  - every path returns JSON. Nothing escapes.
 */

type Json = Record<string, unknown>

const errorBody = (code: string, message: string, retryable: boolean, detail?: string): Json => ({
  error: { code, message, retryable, ...(detail ? { detail } : {}) },
})

/** Loads the host-agnostic core. Kept dynamic so a resolution failure is reportable. */
async function loadHandler() {
  const mod = await import('../server/handler.js')
  if (typeof mod.handleTurn !== 'function') {
    throw new Error('handler module loaded but exports no handleTurn')
  }
  return mod.handleTurn
}

/** Vercel may pre-parse the body, hand it over as text, or leave the stream. */
async function readBody(req: any): Promise<unknown> {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'string') return JSON.parse(req.body)
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'))
    return req.body
  }
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (!chunks.length) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res: any, status: number, body: Json | unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/* ---- Node signature: (req, res) ------------------------------------- */

async function nodeStyle(req: any, res: any) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, errorBody('bad_request', 'Use POST.', false))
    }

    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return send(res, 400, errorBody('bad_request', 'That request could not be read.', false))
    }

    let handleTurn: Awaited<ReturnType<typeof loadHandler>>
    try {
      handleTurn = await loadHandler()
    } catch (err) {
      console.error('[lock] failed to load handler:', err)
      return send(
        res,
        500,
        errorBody('server_boot', 'Lock could not start.', true, describe(err)),
      )
    }

    const result = await handleTurn(body)
    return send(res, result.status, result.body)
  } catch (err) {
    console.error('[lock] unhandled error in function:', err)
    try {
      return send(res, 500, errorBody('server_crash', 'Something went wrong.', true, describe(err)))
    } catch {
      /* the response is already gone; nothing more to do */
    }
  }
}

/* ---- Web signature: (Request) -> Response ---------------------------- */

async function webStyle(request: Request): Promise<Response> {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })

  try {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify(errorBody('bad_request', 'Use POST.', false)), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST' },
      })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(errorBody('bad_request', 'That request could not be read.', false), 400)
    }

    let handleTurn: Awaited<ReturnType<typeof loadHandler>>
    try {
      handleTurn = await loadHandler()
    } catch (err) {
      console.error('[lock] failed to load handler:', err)
      return json(errorBody('server_boot', 'Lock could not start.', true, describe(err)), 500)
    }

    const result = await handleTurn(body)
    return json(result.body, result.status)
  } catch (err) {
    console.error('[lock] unhandled error in function:', err)
    return json(errorBody('server_crash', 'Something went wrong.', true, describe(err)), 500)
  }
}

/** Never includes secrets: only the error's own type and message. */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300)
  return String(err).slice(0, 300)
}

export default function handler(a: any, b?: any) {
  // A Node response object is unmistakable; anything else is the Web signature.
  if (b && typeof b.setHeader === 'function') return nodeStyle(a, b)
  return webStyle(a as Request)
}
