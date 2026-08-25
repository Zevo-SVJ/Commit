/**
 * Deployment diagnostics. Deliberately imports nothing.
 *
 * If /api/health answers and /api/decision does not, the problem is the
 * decision function's module graph, not routing or the platform.
 *
 * `?probe=1` additionally asks the provider two questions — is this key
 * accepted, and does this account have credit — and reports the answers as
 * classifications. It never reports the key.
 */

const OPENAI = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
const MODEL = process.env.LOCK_MODEL || 'gpt-4.1'

type Probe = {
  keyAccepted: boolean | null
  modelAvailable: boolean | null
  canGenerate: boolean | null
  /** One of: ok, auth, quota, rate_limited, model_unavailable, upstream, unreachable. */
  verdict: string
  /** The provider's own error code, never its message verbatim. */
  providerCode: string | null
  advice: string | null
}

/** Free: proves whether the key is accepted at all, and whether the model exists. */
async function checkKey(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${OPENAI}/models/${encodeURIComponent(MODEL)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (res.ok) return { keyAccepted: true, modelAvailable: true }

    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; type?: string } }
    const code = body.error?.code ?? body.error?.type ?? null
    if (res.status === 401 || res.status === 403) {
      return {
        keyAccepted: false, modelAvailable: null, verdict: 'auth', providerCode: code,
        advice: 'The key was rejected. Check it was pasted whole, then redeploy.',
      }
    }
    if (res.status === 404) {
      return {
        keyAccepted: true, modelAvailable: false, verdict: 'model_unavailable', providerCode: code,
        advice: `This account cannot use "${MODEL}". Set LOCK_MODEL to one it can.`,
      }
    }
    return { keyAccepted: true, modelAvailable: null, verdict: 'upstream', providerCode: code }
  } catch {
    return { verdict: 'unreachable', advice: 'Could not reach the provider from this function.' }
  }
}

/** Costs a few tokens: the only way to tell an empty account from a working one. */
async function checkQuota(key: string): Promise<Partial<Probe>> {
  try {
    const res = await fetch(`${OPENAI}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: 'ping', max_output_tokens: 16 }),
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) return { canGenerate: true, verdict: 'ok', advice: null }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; type?: string; message?: string }
    }
    const code = body.error?.code ?? body.error?.type ?? null
    const message = body.error?.message ?? ''
    const quota =
      code === 'insufficient_quota' ||
      code === 'billing_hard_limit_reached' ||
      /quota|billing|credit|payment/i.test(message)

    if (res.status === 429 && quota) {
      return {
        canGenerate: false, verdict: 'quota', providerCode: code,
        advice:
          'The key is valid but the account has no credit. Add a payment method and credit at platform.openai.com/settings/organization/billing. Project keys can also carry their own spend limit.',
      }
    }
    if (res.status === 429) {
      return {
        canGenerate: false, verdict: 'rate_limited', providerCode: code,
        advice: 'A real rate limit. This one does clear on its own.',
      }
    }
    return { canGenerate: false, verdict: 'upstream', providerCode: code }
  } catch {
    return { canGenerate: false, verdict: 'unreachable' }
  }
}

export default async function handler(req: any, b?: any) {
  const key = (process.env.OPENAI_API_KEY ?? '').trim()
  const rawKey = process.env.OPENAI_API_KEY ?? ''

  const url = new URL(req?.url ?? '/', 'http://localhost')
  const wantsProbe = url.searchParams.get('probe') === '1'

  let probe: Probe | null = null
  if (wantsProbe && key) {
    const first = await checkKey(key)
    // Only ask about credit once the key and the model have both checked out.
    // Otherwise a passing credit check would overwrite the real verdict.
    const settled = first.keyAccepted === false || first.modelAvailable === false
    const second = settled ? {} : await checkQuota(key)
    probe = {
      keyAccepted: null, modelAvailable: null, canGenerate: null,
      verdict: 'unknown', providerCode: null, advice: null,
      ...first, ...second,
    }
  }

  const body = {
    ok: true,
    service: 'lock',
    // Whether a key reached the runtime at all. Environment variable changes
    // only apply to deployments made after the change.
    key: {
      present: rawKey.length > 0,
      length: rawKey.length,
      prefix: rawKey ? rawKey.slice(0, 3) : null,
      looksWellFormed: /^sk-[A-Za-z0-9_\-]{20,}$/.test(key),
      hasWhitespace: rawKey !== rawKey.trim(),
    },
    model: MODEL,
    baseUrlOverridden: Boolean(process.env.OPENAI_BASE_URL),
    probe,
    probeHint: wantsProbe ? null : 'add ?probe=1 to test the key against the provider',
    node: process.version,
    region: process.env.VERCEL_REGION ?? null,
    env: process.env.VERCEL_ENV ?? 'local',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  }

  const text = JSON.stringify(body, null, 2)
  if (b && typeof b.setHeader === 'function') {
    b.statusCode = 200
    b.setHeader('content-type', 'application/json; charset=utf-8')
    b.setHeader('cache-control', 'no-store')
    b.end(text)
    return
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
