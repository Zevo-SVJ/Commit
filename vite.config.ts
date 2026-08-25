import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { lockApi } from './server/dev-plugin.ts'

export default defineConfig({
  // The API lives at an absolute path, so the client is served from the root.
  plugins: [react(), lockApi()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
})
