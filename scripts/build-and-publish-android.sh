#!/usr/bin/env bash
# Build PandaFM's signed Android APK on this host and publish it for self-hosted updates (5.4.1).
#
#   cd ~/PandaFM-build && ./scripts/build-and-publish-android.sh [branch]     # default: main
#
# 1-6. builds with scripts/build-android-apk.sh: its build lock, a fresh origin/<branch> checkout and
#      the same persistent signing key as every earlier PandaFM build (outside Git and outside the
#      PandaFM containers, which never see it);
# 7-13. checks the APK, then publishes PandaFM-<version>.apk and latest.json atomically (temporary
#      name, then rename: the manifest is written last, so it never points at a missing APK), keeps a
#      few older APKs, and prints what it published.
#
# Environment:
#   PANDAFM_RELEASES_DIR      host release directory (default /srv/pandafm/releases), mounted
#                             read-only into the PandaFM stack as /releases
#   PANDAFM_RELEASE_NOTES     short notes shown in the app (default "PandaFM <version>")
#   PANDAFM_KEEP_RELEASES     older APKs to keep (default 3)
#   PANDAFM_ALLOW_REPUBLISH=1 publish the same versionCode again (a rebuild of the same version)
#   PANDAFM_PUBLISH_APK       publish this already-built APK instead of building (manual/testing)
set -euo pipefail

die() { echo "build-and-publish-android: $*" >&2; exit 1; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
branch="${1:-${PANDAFM_BRANCH:-main}}"
releases="${PANDAFM_RELEASES_DIR:-/srv/pandafm/releases}"
android="$releases/android"
keep="${PANDAFM_KEEP_RELEASES:-3}"
command -v python3 >/dev/null || die "python3 is needed to write the release manifest"

if [ -n "${PANDAFM_PUBLISH_APK:-}" ]; then
  apk="$PANDAFM_PUBLISH_APK"
else
  "$repo/scripts/build-android-apk.sh" "$branch"
  apk="$repo/web/android/app/build/outputs/apk/debug/app-debug.apk"
fi

props="${PANDAFM_VERSION_PROPERTIES:-$repo/web/android/app/version.properties}"
version_name="$(sed -n 's/^versionName=//p' "$props" | tr -d '[:space:]')"
version_code="$(sed -n 's/^versionCode=//p' "$props" | tr -d '[:space:]')"
[[ "$version_name" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$ ]] || die "unexpected versionName '$version_name' in $props"
[[ "$version_code" =~ ^[1-9][0-9]{0,9}$ ]] || die "unexpected versionCode '$version_code' in $props"

[ -s "$apk" ] || die "no APK at $apk (did the build fail?)"
[ "$(head -c 4 "$apk" | od -An -tx1 | tr -d ' \n')" = "504b0304" ] || die "$apk isn't an APK"

mkdir -p "$android"
chmod 0755 "$releases" "$android" 2>/dev/null || true
exec 8>"$android/.publish.lock"
flock -n 8 || die "another publish is running"

current="$(python3 -c 'import json,sys
try: print(int(json.load(open(sys.argv[1])).get("versionCode", 0)))
except Exception: print(0)' "$android/latest.json")"
if [ "$version_code" -lt "$current" ]; then die "versionCode $version_code is older than the published $current: refusing a downgrade"; fi
if [ "$version_code" -eq "$current" ] && [ "${PANDAFM_ALLOW_REPUBLISH:-0}" != "1" ]; then
  die "versionCode $version_code is already published (set PANDAFM_ALLOW_REPUBLISH=1 to replace it)"
fi

name="PandaFM-$version_name.apk"
sha="$(sha256sum "$apk" | cut -d' ' -f1)"
size="$(stat -c %s "$apk")"
tmp="$android/.$name.tmp.$$"
manifest_tmp="$android/.latest.json.tmp.$$"
trap 'rm -f "$tmp" "$manifest_tmp"' EXIT

cp "$apk" "$tmp"
chmod 0644 "$tmp"
[ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$sha" ] || die "the copy doesn't match the build"
mv -f "$tmp" "$android/$name"  # atomic within one filesystem

python3 - "$manifest_tmp" "$version_name" "$version_code" "$name" "$sha" "$size" "${PANDAFM_RELEASE_NOTES:-PandaFM $version_name}" <<'PY'
import datetime, json, sys
path, name, code, filename, sha, size, notes = sys.argv[1:8]
manifest = {
    "platform": "android", "versionName": name, "versionCode": int(code), "filename": filename,
    "downloadUrl": f"/downloads/android/{filename}", "sha256": sha, "size": int(size),
    "releasedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "notes": notes[:2000],
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
chmod 0644 "$manifest_tmp"
mv -f "$manifest_tmp" "$android/latest.json"  # last: clients only ever see a complete release

# Keep the newest few older APKs; never the one just published.
# (grep finding nothing older is fine: it must not fail the publish under pipefail.)
{ ls -1t "$android"/PandaFM-*.apk 2>/dev/null | { grep -vF "/$name" || true; } | tail -n +"$((keep + 1))"; } | while read -r old; do rm -f -- "$old"; done

echo "Published PandaFM $version_name (versionCode $version_code)"
echo "  APK:      $android/$name ($size bytes)"
echo "  SHA-256:  $sha"
echo "  Manifest: $android/latest.json  →  /api/releases/android/latest"
