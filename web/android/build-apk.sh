#!/usr/bin/env bash
# Build the PandaFM Android app (debug-signed APK) with nothing but Docker.
#
#   ./web/android/build-apk.sh                 HTTPS-only build (recommended)
#   PANDAFM_ANDROID_ALLOW_HTTP=1 ./web/android/build-apk.sh
#                                              also allows a plain-http LAN server
#
# Result: web/android/app/build/outputs/apk/debug/app-debug.apk
# The Android SDK and Gradle caches live in Docker volumes, so later builds are quick.
set -euo pipefail
cd "$(dirname "$0")/.."   # web/
ALLOW_HTTP="${PANDAFM_ANDROID_ALLOW_HTTP:-0}"
OWNER="$(id -u):$(id -g)"

echo "==> Building the web app and copying it into the Android project"
docker run --rm -v "$PWD":/app -w /app -e PANDAFM_ANDROID_ALLOW_HTTP="$ALLOW_HTTP" node:22 \
  sh -c "npm install --no-audit --no-fund && npm run build && npx cap sync android && chown -R $OWNER /app/dist /app/android /app/node_modules"

echo "==> Building the APK"
docker run --rm -v "$PWD":/app -w /app/android \
  -v pandafm-android-sdk:/opt/android-sdk -v pandafm-gradle:/root/.gradle \
  -e ANDROID_HOME=/opt/android-sdk -e ALLOW_HTTP="$ALLOW_HTTP" eclipse-temurin:21-jdk bash -c '
    set -e
    SDKM=$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager
    if [ ! -x "$SDKM" ]; then
      apt-get update -qq && apt-get install -y -qq unzip curl >/dev/null
      curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
      mkdir -p $ANDROID_HOME/cmdline-tools && unzip -q /tmp/tools.zip -d $ANDROID_HOME/cmdline-tools
      mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest
    fi
    yes | $SDKM --licenses >/dev/null || true
    $SDKM --install "platforms;android-36" "build-tools;36.0.0" "platform-tools" >/dev/null
    EXTRA=""; [ "$ALLOW_HTTP" = "1" ] && EXTRA="-PpandafmAllowHttp=true"
    ./gradlew --no-daemon assembleDebug testDebugUnitTest $EXTRA
    chown -R '"$OWNER"' /app/android
  '
echo "==> Done: web/android/app/build/outputs/apk/debug/app-debug.apk"
