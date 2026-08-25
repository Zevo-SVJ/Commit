/**
 * Deployment diagnostics. Deliberately imports nothing.
 *
 * If /api/health answers and /api/decision does not, the problem is the
 * decision function's module graph, not routing or the platform. That one
 * distinction is otherwise very hard to make from outside.
 *
 * Reports whether a key is present and what shape it has — never the key.
 */
export default function handler(_req: any, b?: any) {
  const key = process.env.OPENAI_API_KEY ?? ''

  const body = {
    ok: true,
    service: 'lock',
    // Whether a key reached the runtime at all. Vercel only applies
    // environment variable changes to deployments made after the change.
    key: {
      present: key.length > 0,
      // Enough to spot a pasted quote, a stray space, or a truncated paste.
      length: key.length,
      prefix: key ? key.slice(0, 3) : null,
      looksWellFormed: /^sk-[A-Za-z0-9_\-]{20,}$/.test(key),
      hasWhitespace: key !== key.trim(),
    },
    model: process.env.LOCK_MODEL || 'gpt-4.1 (default)',
    baseUrlOverridden: Boolean(process.env.OPENAI_BASE_URL),
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    env: process.env.VERCEL_ENV ?? 'local',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  }

  if (b && typeof b.setHeader === 'function') {
    b.statusCode = 200
    b.setHeader('content-type', 'application/json; charset=utf-8')
    b.setHeader('cache-control', 'no-store')
    b.end(JSON.stringify(body, null, 2))
    return
  }
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
