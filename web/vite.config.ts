import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The app always calls the API at a relative /api path, so the same build
// works behind any host name. During `npm run dev`, /api is forwarded to a
// running PandaFM stack:
//   PANDAFM_DEV_API=http://192.168.1.50 npm run dev
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      host: true, // reachable from your phone on the LAN while developing
      proxy: {
        '/api': { target: env.PANDAFM_DEV_API || 'http://localhost', changeOrigin: true },
      },
    },
  }
})
