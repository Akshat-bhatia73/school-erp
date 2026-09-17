import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The API is same-origin through this proxy. `changeOrigin` stays false on purpose: the API
 * checks the Origin and Host headers against APP_ORIGIN (http://localhost:5173), so they must
 * arrive unchanged. Session cookies are HttpOnly and travel with the proxied request.
 *
 * The port and the proxy target are the development defaults. API_PROXY_TARGET and WEB_PORT
 * exist only so the browser test suite (tests/browser) can start a second, isolated pair on
 * other ports; unset, nothing changes.
 */
const apiProxy = {
  '/api': {
    target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3001',
    changeOrigin: false,
  },
}

const requestedPort = Number(process.env.WEB_PORT)
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 5173

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { port, proxy: apiProxy },
  preview: { port, proxy: apiProxy },
})
