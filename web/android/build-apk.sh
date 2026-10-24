#!/usr/bin/env bash
# Build the PandaFM Android app (debug-signed APK) with nothing but Docker.
#
#   ./web/android/build-apk.sh                 HTTPS-only build (recommended)
#   PANDAFM_ANDROID_ALLOW_HTTP=1 ./web/android/build-apk.sh
#                                              also allows a plain-http LAN server
#
# Result: web/android/app/build/outputs/apk/debug/app-debug.apk
# The Android SDK and Gradle caches live in Docker volumes, so later builds are quick.
#
# Signing: every build is signed with the same PandaFM development key, so a
# new APK installs over the previous one. The key is created on the first run
# in the Docker volume "pandafm-android-signing" (or the folder given in
# PANDAFM_SIGNING_DIR) and is never committed. Back it up: see docs/android.md.
set -euo pipefail
cd "$(dirname "$0")/.."   # web/
ALLOW_HTTP="${PANDAFM_ANDROID_ALLOW_HTTP:-0}"
OWNER="$(id -u):$(id -g)"
SIGNING="${PANDAFM_SIGNING_DIR:-pandafm-android-signing}"

echo "==> Building the web app and copying it into the Android project"
docker run --rm -v "$PWD":/app -w /app -e PANDAFM_ANDROID_ALLOW_HTTP="$ALLOW_HTTP" node:22 \
  sh -c "npm install --no-audit --no-fund && npm run build && npx cap sync android && chown -R $OWNER /app/dist /app/android /app/node_modules"

echo "==> Building the APK"
docker run --rm -v "$PWD":/app -w /app/android \
  -v pandafm-android-sdk:/opt/android-sdk -v pandafm-gradle:/root/.gradle -v "$SIGNING":/signing \
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
    if [ ! -f /signing/pandafm-dev.p12 ]; then
      echo "==> First build: creating the PandaFM development signing key (kept in $SIGNING)"
      ( umask 077
        head -c 48 /dev/urandom | base64 | tr -dc "A-Za-z0-9" | head -c 32 > /signing/.password
        keytool -genkeypair -keystore /signing/pandafm-dev.p12 -storetype PKCS12 -alias pandafm-dev \
          -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=PandaFM Development, O=PandaFM" \
          -storepass:file /signing/.password -keypass:file /signing/.password >/dev/null
        PW="$(cat /signing/.password)"
        printf "storeFile=/signing/pandafm-dev.p12\nstorePassword=%s\nkeyAlias=pandafm-dev\nkeyPassword=%s\n" "$PW" "$PW" > /signing/signing.properties )
    fi
    echo "==> Signing with: $(keytool -list -keystore /signing/pandafm-dev.p12 -storepass:file /signing/.password -alias pandafm-dev | grep -o "SHA-256.*" | head -1)"
    EXTRA=""; [ "$ALLOW_HTTP" = "1" ] && EXTRA="-PpandafmAllowHttp=true"
    ./gradlew --no-daemon assembleDebug testDebugUnitTest -PpandafmSigning=/signing/signing.properties $EXTRA
    chown -R '"$OWNER"' /app/android
  '
echo "==> Done: web/android/app/build/outputs/apk/debug/app-debug.apk"
