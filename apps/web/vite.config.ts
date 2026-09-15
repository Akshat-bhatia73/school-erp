import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The API is same-origin through this proxy. `changeOrigin` stays false on purpose: the API
 * checks the Origin and Host headers against APP_ORIGIN (http://localhost:5173), so they must
 * arrive unchanged. Session cookies are HttpOnly and travel with the proxied request.
 */
const apiProxy = {
  '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
}

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { port: 5173, proxy: apiProxy },
  preview: { port: 5173, proxy: apiProxy },
})
