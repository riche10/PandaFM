import type { CapacitorConfig } from '@capacitor/cli'

// The Android app loads the same React build as the web version (dist/) from
// inside the APK, and talks to the PandaFM server the user configures.
//
// HTTPS servers work out of the box. For a plain-http LAN server, build with
// PANDAFM_ANDROID_ALLOW_HTTP=1 (and -PpandafmAllowHttp=true for Gradle): see
// docs/android.md. It is off by default so release builds stay HTTPS-only.
const allowHttp = process.env.PANDAFM_ANDROID_ALLOW_HTTP === '1'

const config: CapacitorConfig = {
  appId: 'app.pandafm.client',
  appName: 'PandaFM',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  android: { allowMixedContent: allowHttp },
}

export default config
