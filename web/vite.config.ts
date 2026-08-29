import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Two products, two bundles, chosen by mode — never by which env vars happen to be set.
//
//   vite build              -> the local board (index.html -> src/main.tsx)
//   vite build --mode cloud -> the shared cloud workspace (cloud.html -> src/cloud-main.tsx)
//
// Only the cloud mode loads .env.cloud.local, so a local build cannot pick up
// VITE_CLERK_PUBLISHABLE_KEY / VITE_HUB_BASE_URL and hand the daemon a bundle that
// blocks on Clerk behind the daemon's `script-src 'self'` CSP.

// The dev server always resolves "/" to index.html, so without this `vite --mode cloud`
// would serve the local board at "/" while the cloud build serves the cloud app there.
// Rewriting keeps dev honest about which product it is running.
function serveCloudEntryAtRoot(): Plugin {
  return {
    name: 'orchestra-cloud-entry',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/cloud.html'
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'cloud' ? [serveCloudEntryAtRoot()] : [])],
  server: { proxy: { '/api': 'http://localhost:4750' } },
  build: {
    rollupOptions: { input: mode === 'cloud' ? 'cloud.html' : 'index.html' },
  },
}))
