#!/usr/bin/env bash
# Codesign → notarize → staple → verify a DMG.
#
# electron-builder normally signs+notarizes+staples the DMG during
# `npm run package`, but a transient `hdiutil detach` race during DMG creation
# can leave the container unsigned (the app inside is still fine). Run this to
# finish the container so opening the DMG is warning-free too.
#
# Usage:  set -a; source .env; set +a
#         scripts/notarize-dmg.sh [path/to.dmg]   # defaults to the newest dist/*.dmg
set -euo pipefail

DMG="${1:-$(ls -t dist/*.dmg | head -1)}"
[ -f "$DMG" ] || { echo "no DMG found ($DMG)"; exit 1; }
: "${APPLE_API_KEY:?set APPLE_API_KEY (source .env)}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"

# Auto-detect the Developer ID Application identity from the login keychain.
ID="$(security find-identity -v -p codesigning \
  | grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)".*/\1/')"
[ -n "$ID" ] || { echo "no 'Developer ID Application' identity in keychain"; exit 1; }

echo "==> signing  $DMG  ($ID)"
codesign --force --timestamp --sign "$ID" "$DMG"

echo "==> notarizing"
xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait

echo "==> stapling"
xcrun stapler staple "$DMG"

echo "==> verifying"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
