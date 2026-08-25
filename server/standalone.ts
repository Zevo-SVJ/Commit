import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { serveDecision } from './http.ts'

/**
 * Self-hosted server: the built client plus the API, on one port.
 * `npm run build && npm start` — for any host that runs Node.
 */

const PORT = Number(process.env.PORT ?? 3000)
const ROOT = join(process.cwd(), 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/api/decision') {
    serveDecision(req, res).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'upstream', message: 'Something went wrong.', retryable: true } }))
    })
    return
  }

  // Static files, with traversal blocked, falling back to the SPA entry.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(ROOT, rel)
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ROOT, 'index.html')
  }
  if (!existsSync(file)) {
    res.writeHead(404).end('Not found')
    return
  }

  const immutable = rel.startsWith('/assets/')
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}).listen(PORT, () => {
  console.log(`LOCK on http://localhost:${PORT}`)
  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY is not set — the app will load but cannot reason.')
  }
})
