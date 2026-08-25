import type { Plugin } from 'vite'

/**
 * Mounts the API inside `vite dev` and `vite preview`.
 *
 * The handler is loaded through Vite's own module runner rather than imported
 * at the top of this file: the config is bundled by esbuild, which would have
 * to resolve the server's TypeScript specifiers itself. Going through
 * `ssrLoadModule` keeps that resolution where it belongs and hot-reloads the
 * server code between requests.
 */
export function lockApi(): Plugin {
  const mount = (server: { middlewares: any; ssrLoadModule: (id: string) => Promise<any> }) => {
    server.middlewares.use('/api/decision', (req: any, res: any, next: any) => {
      server
        .ssrLoadModule('/server/http.ts')
        .then((mod) => mod.serveDecision(req, res))
        .catch(next)
    })
  }

  return {
    name: 'lock-api',
    configureServer: mount,
    configurePreviewServer(server) {
      // `vite preview` has no module runner, so serve the built handler.
      server.middlewares.use('/api/decision', (req: any, res: any, next: any) => {
        import('./http.js')
          .then((mod) => mod.serveDecision(req, res))
          .catch(next)
      })
    },
  }
}
