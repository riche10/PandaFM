#!/usr/bin/env bash
# PandaFM: one command to build the Android APK on the build server.
#
#   scripts/build-android-apk.sh [branch]        # default: main
#
# 1. fetches origin and hard-resets the checkout to origin/<branch>
#    (local changes to tracked files in this checkout are discarded),
# 2. regenerates the launcher icons if web/assets has icon artwork,
# 3. builds with ./web/android/build-apk.sh (Docker; same persistent signing
#    key every time, so the APK installs over the previous one),
# 4. prints where the APK is.
#
# Options (environment):
#   PANDAFM_ANDROID_ALLOW_HTTP=1  (default) plain-http LAN servers allowed; 0 = HTTPS-only build
#   PANDAFM_ANDROID_ICONS=auto    (default) regenerate icons when artwork exists; 1 always; 0 never
#   PANDAFM_REMOTE=origin         git remote to update from
set -euo pipefail

main() {
  local branch="${1:-${PANDAFM_BRANCH:-main}}"
  local repo
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  local remote="${PANDAFM_REMOTE:-origin}"
  cd "$repo"

  if [ -z "${PANDAFM_BUILD_UPDATED:-}" ]; then
    # Only one build at a time on this machine.
    exec 9>"${TMPDIR:-/tmp}/pandafm-apk-build.lock"
    if ! flock -n 9; then
      echo "Another PandaFM APK build is running; try again when it's done." >&2
      exit 1
    fi
    echo "==> Updating $repo to $remote/$branch"
    git fetch --prune "$remote"
    if ! git rev-parse --verify --quiet "$remote/$branch" >/dev/null; then
      echo "Branch '$branch' doesn't exist on $remote." >&2
      exit 1
    fi
    git checkout -q -B "$branch" "$remote/$branch"
    git reset -q --hard "$remote/$branch"
    # Run the freshly updated copy of this script for the rest (keeping the lock).
    if [ -f "$repo/scripts/build-android-apk.sh" ]; then
      PANDAFM_BUILD_UPDATED=1 exec "$repo/scripts/build-android-apk.sh" "$branch"
    fi
    echo "==> $branch doesn't have this script yet; continuing with the copy that's running"
  fi

  local commit
  commit="$(git rev-parse --short HEAD)"
  echo "==> Building PandaFM $branch @ $commit"

  local icons
  # 5.4: EITHER source (PNG or SVG) enables regeneration; damaged artwork is caught, not shipped.
  icons="$(PANDAFM_ANDROID_ICONS="${PANDAFM_ANDROID_ICONS:-auto}" sh scripts/android-icons-mode.sh .)" || exit 1
  [ "$icons" = "1" ] && echo "==> Launcher icons will be regenerated from web/assets"

  PANDAFM_ANDROID_ALLOW_HTTP="${PANDAFM_ANDROID_ALLOW_HTTP:-1}" PANDAFM_ANDROID_ICONS="$icons" ./web/android/build-apk.sh
  if [ "$icons" = "1" ] && command -v python3 >/dev/null 2>&1; then python3 scripts/check-android-icons.py --stamp; fi  # the icons now match these sources

  local apk="$repo/web/android/app/build/outputs/apk/debug/app-debug.apk"
  if [ ! -f "$apk" ]; then
    echo "The build finished but no APK was found at $apk" >&2
    exit 1
  fi
  local version
  version="$(grep -E '^versionName=' web/android/app/version.properties | cut -d= -f2)"
  echo
  echo "PandaFM $version ($branch @ $commit) APK:"
  echo "$apk"
}

main "$@"
