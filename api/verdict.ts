/**
 * Lock's verdict endpoint — the `lock-ai-logic` backend, now owned by Lock.
 *
 * Same wire contract as the Lovable deployment's POST /api/public/decision, so
 * anything written against that keeps working; `vercel.json` rewrites that path
 * here. Written in the same defensive style as api/decision.ts: both host
 * signatures, a dynamic import so a module failure is reportable rather than a
 * crash, and JSON on every path.
 */

type Json = Record<string, unknown>

const fail = (code: string, message: string): Json => ({ error: { code, message } })

/**
 * Same-origin by default: Lock's own frontend needs no CORS at all, so none is
 * sent unless an origin is explicitly allowed. The Lovable backend answered
 * `Access-Control-Allow-Origin: *` because it was a standalone public API;
 * inside Lock that would be a wider door than the product needs.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (process.env.LOCK_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (!origin || !allowed.length) return {}
  const ok = allowed.includes('*') || allowed.includes(origin)
  if (!ok) return {}
  return {
    'access-control-allow-origin': allowed.includes('*') ? '*' : origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Accept',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

async function loadHandler() {
  const mod = await import('../server/verdict.js')
  if (typeof mod.handleVerdict !== 'function') {
    throw new Error('verdict module loaded but exports no handleVerdict')
  }
  return mod.handleVerdict
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

/** Fires if the caller goes away before we answer. See api/decision.ts. */
function callerSignalFor(res: any): AbortSignal | undefined {
  if ((process.env.LOCK_CANCEL_ON_DISCONNECT ?? '').trim() === '0') return undefined
  if (!res || typeof res.on !== 'function') return undefined
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded && !res.headersSent && res.destroyed) controller.abort()
  })
  return controller.signal
}

async function nodeStyle(req: any, res: any) {
  const cors = corsHeaders(req?.headers?.origin ?? null)
  const send = (status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
    res.end(JSON.stringify(body))
  }

  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
      return res.end()
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(405, fail('invalid_request', 'Use POST.'))
    }

    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      return send(400, fail('invalid_request', 'Body must be valid JSON.'))
    }

    let handleVerdict: Awaited<ReturnType<typeof loadHandler>>
    try {
      handleVerdict = await loadHandler()
    } catch (err) {
      console.error('[lock] failed to load verdict module:', err)
      return send(500, fail('internal_error', 'Lock could not start its decision engine.'))
    }

    const result = await handleVerdict(body, undefined, callerSignalFor(res))
    if (res.writableEnded) return
    return send(result.status, result.body)
  } catch (err) {
    console.error('[lock] unhandled error in verdict function:', err)
    try {
      return send(500, fail('internal_error', 'The decision turn could not be completed.'))
    } catch {
      /* the response is already gone */
    }
  }
}

async function webStyle(request: Request): Promise<Response> {
  const cors = corsHeaders(request.headers.get('origin'))
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...cors,
      },
    })

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (request.method !== 'POST') {
      return new Response(JSON.stringify(fail('invalid_request', 'Use POST.')), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8', allow: 'POST', ...cors },
      })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(fail('invalid_request', 'Body must be valid JSON.'), 400)
    }

    let handleVerdict: Awaited<ReturnType<typeof loadHandler>>
    try {
      handleVerdict = await loadHandler()
    } catch (err) {
      console.error('[lock] failed to load verdict module:', err)
      return json(fail('internal_error', 'Lock could not start its decision engine.'), 500)
    }

    const result = await handleVerdict(body, undefined, request.signal)
    return json(result.body, result.status)
  } catch (err) {
    console.error('[lock] unhandled error in verdict function:', err)
    return json(fail('internal_error', 'The decision turn could not be completed.'), 500)
  }
}

export default function handler(a: any, b?: any) {
  if (b && typeof b.setHeader === 'function') return nodeStyle(a, b)
  return webStyle(a as Request)
}
