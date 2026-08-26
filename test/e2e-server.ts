/**
 * Test harness: the real client bundle and the real handler, driven by a
 * scripted provider instead of a model. Lets the browser tests walk complete
 * journeys deterministically, including failures a live model rarely produces.
 *
 * Not part of the product. `npm run build && node test/e2e-server.ts`.
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { handleTurn } from '../server/handler.js'
import { ProviderError, type Provider } from '../server/ai/provider.js'

const PORT = Number(process.env.PORT ?? 4300)
const ROOT = join(process.cwd(), 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const step = (over: Record<string, unknown>) => ({
  kind: 'question', prompt: null, why: null, options: null, allowFree: null,
  question: null, commitment: null, rationale: null, isFinal: null,
  importance: null, closing: null, framing: null, ...over,
})

const turn = (progress: number, s: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  title: 'The Halden partnership',
  understanding: {
    objective: 'Decide whether the partnership is worth its terms',
    known: ['EUR 120k for nine months', 'Exclusivity is the live cost'],
    openQuestions: [], criticalUnknown: 'What exclusivity blocks', contradiction: null,
  },
  progress, confidence: 0.7, step: step(s), ...over,
})

const SCRIPTS: Record<string, unknown[]> = {
  multi: [
    turn(0.3, {
      kind: 'question',
      prompt: 'How much of next year is already committed?',
      why: 'Decides whether exclusivity costs anything real.',
      options: ['Nothing yet', 'About half', 'Almost all of it'],
      allowFree: true,
      framing: 'The money is settled. Exclusivity is not.',
    }),
    turn(0.55, {
      kind: 'decision', question: 'Should I pursue the partnership?',
      commitment: 'Pursue the partnership.',
      rationale: 'The risk sits in the terms, not the relationship.',
      isFinal: false, importance: 'pivotal',
      framing: 'Half a year committed makes this an addition, not a replacement.',
    }),
    turn(0.78, {
      kind: 'decision', question: 'Should I negotiate the terms?',
      commitment: 'Negotiate before agreeing.',
      rationale: 'Signing as offered prices eighteen months at zero.',
      isFinal: false, importance: 'standard', framing: null,
    }),
    turn(0.94, {
      kind: 'decision', question: 'Should I sign the final agreement?',
      commitment: 'Sign the agreement.',
      rationale: 'The terms now match what you said you would accept.',
      isFinal: true, importance: 'pivotal',
      framing: 'They moved on the window and asked for the IP instead.',
    }),
    turn(1, { kind: 'complete', closing: 'You know what you are doing.' }),
  ],
  single: [
    turn(0.6, {
      kind: 'decision', question: 'Should I get a cat?', commitment: 'Get the cat.',
      rationale: 'Nothing you raised is a reason not to.',
      isFinal: true, importance: 'pivotal', framing: null,
    }, { title: 'Getting a cat' }),
    turn(1, { kind: 'complete', closing: 'You know what you are doing.' }, { title: 'Getting a cat' }),
  ],
  contradiction: [
    turn(
      0.5,
      {
        kind: 'decision', question: 'Should I pursue the partnership?',
        commitment: 'Pursue the partnership.', rationale: 'The risk is in the terms.',
        isFinal: true, importance: 'pivotal', framing: 'Exclusivity is the live cost.',
      },
      {
        understanding: {
          objective: 'Decide whether the partnership is worth its terms',
          known: ['Money is the stated motivation'], openQuestions: [],
          criticalUnknown: 'What exclusivity blocks',
          contradiction: 'You call this obvious, but you have left it three weeks.',
        },
      },
    ),
    turn(1, { kind: 'complete', closing: 'You know what you are doing.' }),
  ],
  userDecision: [
    turn(0.5, {
      kind: 'decision', question: 'Should I pursue the partnership?',
      commitment: 'Pursue the partnership.', rationale: 'The risk is in the terms.',
      isFinal: true, importance: 'pivotal', framing: null,
    }),
    turn(0.4, {
      kind: 'decision', question: 'Should I decide whether I trust them?',
      commitment: 'Settle whether you trust them.',
      rationale: 'You raised this yourself.',
      isFinal: true, importance: 'pivotal', framing: null,
    }),
    turn(1, { kind: 'complete', closing: 'Done.' }),
  ],
}

let mode = 'multi'
let calls = 0
/** Every /api/decision request, so the browser tests can prove there are no duplicates. */
let apiHits = 0
/** Every request that actually reached the provider. The number that costs money. */
let providerHits = 0
/** How long `slow` mode takes, so a test can straddle a timeout deliberately. */
let slowMs = 1200
/** Provider calls that were cancelled before they finished. */
let cancelled = 0

const scripted: Provider = async (_req, signal) => {
  providerHits++
  if (mode === 'error503') throw new ProviderError('no key', 'unconfigured')
  if (mode === 'error429') throw new ProviderError('slow down', 'rate_limited')
  if (mode === 'invalid') return { step: { kind: 'nonsense' } }
  if (mode === 'slow' || mode === 'stall') {
    // Honours the signal, the way a real provider does — so a cancelled turn
    // stops costing something the moment nobody is waiting for it.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, mode === 'stall' ? 600_000 : slowMs)
      signal.addEventListener('abort', () => {
        clearTimeout(t)
        cancelled++
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }
  const script = SCRIPTS[mode === 'slow' || mode === 'stall' ? 'multi' : mode] ?? SCRIPTS.multi
  const out = script[Math.min(calls, script.length - 1)]
  calls++
  return out
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/__mode') {
    mode = url.searchParams.get('mode') ?? 'multi'
    calls = Number(url.searchParams.get('calls') ?? 0)
    slowMs = Number(url.searchParams.get('ms') ?? 1200)
    apiHits = 0
    providerHits = 0
    cancelled = 0
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, calls }))
    return
  }

  if (url.pathname === '/__hits') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ apiHits, providerHits, cancelled }))
    return
  }

  if (url.pathname === '/api/decision') {
    apiHits++

    // Reproduces what a misconfigured deployment actually returns: HTML, not
    // JSON — the SPA fallback for a missing function, or a platform error page.
    if (mode === 'html404' || mode === 'html500') {
      res.writeHead(mode === 'html404' ? 404 : 500, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body>The page could not be found</body></html>')
      return
    }
    if (mode === 'empty') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('')
      return
    }

    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    /* The same caller-cancellation wiring the Vercel adapter uses, so the
       browser tests exercise the real thing rather than a simplification. */
    const gone = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded && !res.headersSent && res.destroyed) gone.abort()
    })

    const result = await handleTurn(body, scripted, undefined, gone.signal)
    if (res.writableEnded) return
    res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result.body))
    return
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(ROOT, rel)
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ROOT, 'index.html')
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}).listen(PORT, () => console.log(`e2e harness on ${PORT}`))
