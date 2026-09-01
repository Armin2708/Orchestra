import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// One product, one bundle: the local board (index.html -> src/main.tsx).
//
// The shared cloud workspace is NOT built from this repo. It lives in
// ../orchestraboard/orchestra-cloud-dashboard (frontend) and
// ../orchestraboard/orchestra-cloud-api (hub service) — see CLAUDE.md's
// "Daemon vs cloud" rule. The old `--mode cloud` entry was removed when the
// cloud repos were split out; resurrecting it here would fork the cloud UI
// again.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:4750' } },
  build: {
    rollupOptions: { input: 'index.html' },
  },
})
