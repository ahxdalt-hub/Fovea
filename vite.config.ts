/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed dev port (see src-tauri/tauri.conf.json → devUrl)
// and owns the browser, so no open/host guessing.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo rebuilds would otherwise thrash HMR.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
