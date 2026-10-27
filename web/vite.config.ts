import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/** The app version, from the Android version file (the single source of PandaFM's version). */
function appVersion(): string {
  try {
    return readFileSync(new URL('./android/app/version.properties', import.meta.url), 'utf8').match(/^versionName=(.+)$/m)?.[1]?.trim() ?? 'dev'
  } catch {
    return 'dev'
  }
}

// The app always calls the API at a relative /api path, so the same build
// works behind any host name. During `npm run dev`, /api is forwarded to a
// running PandaFM stack:
//   PANDAFM_DEV_API=http://192.168.1.50 npm run dev
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    server: {
      host: true, // reachable from your phone on the LAN while developing
      proxy: {
        '/api': { target: env.PANDAFM_DEV_API || 'http://localhost', changeOrigin: true },
      },
    },
  }
})
