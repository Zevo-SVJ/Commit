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
  /** Where to go and fix it, when there is such a place. */
  link: string | null
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
        link: 'https://platform.openai.com/api-keys',
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
          'The key is valid but the account has no credit. Add a payment method and credit, then try again. A project key can also carry its own spend limit, separate from the organisation.',
        link: 'https://platform.openai.com/settings/organization/billing/overview',
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

/** A readable page for a browser. No CSS file, no imports — one self-contained view. */
function renderHtml(body: any): string {
  const verdict: string | null = body.probe?.verdict ?? null
  const good = verdict === 'ok'
  const tone = verdict === null ? '#8E9196' : good ? '#7FD1AE' : '#E0C08A'

  const row = (label: string, value: unknown) =>
    `<div class="r"><span>${label}</span><b>${
      value === null || value === undefined ? '—' : String(value)
    }</b></div>`

  const probeRows = body.probe
    ? [
        row('Key accepted', body.probe.keyAccepted),
        row('Model available', body.probe.modelAvailable),
        row('Can generate', body.probe.canGenerate),
        row('Provider code', body.probe.providerCode),
      ].join('')
    : `<p class="hint">Add <code>?probe=1</code> to test the key against the provider.</p>`

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark"><title>Lock — diagnostic</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#08090b;color:#f1f2f4;
 font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
 letter-spacing:-.011em;padding:calc(env(safe-area-inset-top) + 32px) 22px
 calc(env(safe-area-inset-bottom) + 40px)}
main{max-width:520px;margin:0 auto}
h1{font-size:13px;font-weight:600;letter-spacing:.02em;color:#676b71;margin:0 0 22px}
.v{font-size:27px;font-weight:600;letter-spacing:-.03em;margin:0 0 8px;color:${tone}}
.advice{color:#9ea2a8;margin:0 0 18px;font-size:15.5px;text-wrap:pretty;overflow-wrap:anywhere}
.fix{margin:0 0 28px}
.fix a{display:inline-block;color:#0a0b0d;background:#f1f2f4;text-decoration:none;
 font-size:14.5px;font-weight:600;padding:11px 18px;border-radius:12px}
.r{display:flex;justify-content:space-between;gap:16px;padding:12px 0;
 border-top:1px solid rgba(255,255,255,.075);font-size:14.5px}
.r span{color:#8e9196}
.r b{font-weight:500;font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
h2{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;
 color:#494d53;margin:30px 0 4px}
.hint{color:#676b71;font-size:14px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#e0c08a}
a{color:#9ea2a8}
</style></head><body><main>
<h1>Lock — deployment diagnostic</h1>
<p class="v">${verdict ? verdict.replace(/_/g, ' ') : 'not probed'}</p>
${body.probe?.advice ? `<p class="advice">${body.probe.advice}</p>` : ''}
${body.probe?.link ? `<p class="fix"><a href="${body.probe.link}" target="_blank" rel="noreferrer">Open the page that fixes this</a></p>` : ''}
<h2>Provider</h2>${probeRows}
<h2>Key</h2>
${row('Present', body.key.present)}
${row('Length', body.key.length)}
${row('Prefix', body.key.prefix)}
${row('Well formed', body.key.looksWellFormed)}
${row('Stray whitespace', body.key.hasWhitespace)}
<h2>Deployment</h2>
${row('Model', body.model)}
${row('Environment', body.env)}
${row('Commit', body.commit)}
${row('Region', body.region)}
${row('Node', body.node)}
<h2></h2>
<p class="hint">The key itself is never shown or returned.
 <a href="?probe=1&amp;format=json">Raw JSON</a></p>
</main></body></html>`
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
      verdict: 'unknown', providerCode: null, advice: null, link: null,
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

  // A browser gets a page it can read; anything else gets JSON. `?format=json`
  // forces JSON either way.
  const accept: string =
    (typeof req?.headers?.get === 'function' ? req.headers.get('accept') : req?.headers?.accept) ?? ''
  const wantsHtml =
    url.searchParams.get('format') !== 'json' && accept.includes('text/html')

  const text = wantsHtml ? renderHtml(body) : JSON.stringify(body, null, 2)
  const type = wantsHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'

  if (b && typeof b.setHeader === 'function') {
    b.statusCode = 200
    b.setHeader('content-type', type)
    b.setHeader('cache-control', 'no-store')
    b.end(text)
    return
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  })
}
