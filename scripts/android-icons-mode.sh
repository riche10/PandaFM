#!/bin/sh
# Decide whether the Android build regenerates its launcher icons (5.4). Prints 1 or 0.
#   PANDAFM_ANDROID_ICONS=auto (default): 1 when EITHER icon source exists (PNG or SVG) and the
#     PNG sources are valid; damaged sources keep the current icons, with a loud warning.
#   PANDAFM_ANDROID_ICONS=1: always (fails if a source is damaged); 0: never.
# Usage: scripts/android-icons-mode.sh [repo-root]
root="${1:-.}"
mode="${PANDAFM_ANDROID_ICONS:-auto}"
if [ "$mode" = "0" ]; then echo 0; exit 0; fi
have=0
if [ -f "$root/web/assets/app-icon-foreground.png" ] || [ -f "$root/web/assets/app-icon-foreground.svg" ]; then have=1; fi
if [ "$have" = "0" ]; then
  [ "$mode" = "1" ] && { echo "No launcher icon artwork in web/assets (app-icon-foreground.png or .svg)." >&2; exit 1; }
  echo 0; exit 0
fi
if command -v python3 >/dev/null 2>&1 && ! python3 "$root/scripts/check-android-icons.py" --sources; then
  if [ "$mode" = "1" ]; then echo "Fix the damaged icon artwork in web/assets first." >&2; exit 1; fi
  echo "WARNING: the icon artwork in web/assets is damaged; keeping the current launcher icons. Re-export it." >&2
  echo 0; exit 0
fi
echo 1
