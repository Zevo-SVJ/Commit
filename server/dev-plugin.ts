import type { Plugin } from 'vite'
import { serveDecision } from './http.ts'

/**
 * Mounts the API inside `vite dev`, so local development is a single command
 * and exercises exactly the same handler as production.
 */
export function lockApi(): Plugin {
  return {
    name: 'lock-api',
    configureServer(server) {
      server.middlewares.use('/api/decision', (req, res, next) => {
        serveDecision(req, res).catch(next)
      })
    },
    // `vite preview` serves the production bundle; keep the API alive there too.
    configurePreviewServer(server) {
      server.middlewares.use('/api/decision', (req, res, next) => {
        serveDecision(req, res).catch(next)
      })
    },
  }
}
