#!/bin/bash
# Build the Fishtape iOS app against production and upload it to TestFlight. Run on the build Mac:
#   mobile/scripts/testflight.sh            (from anywhere in the repo)
# Steps: npm ci, sync with FISHTAPE_ENV=production, check the App Store Connect app record,
# archive (Release, automatic signing for team 9C68LPL6JA), export + upload, wait for processing,
# put the build in the internal TestFlight group "TG Electrical".
#
# Build number: CURRENT_PROJECT_VERSION=$BUILD_NUMBER (default: UTC YYYYMMDDHHMM, always increasing).
# Marketing version comes from MARKETING_VERSION in the Xcode project (1.0).
# The API key is read from ~/.appstoreconnect/api_key.json inside this script and never printed.
# Output goes to $FISHTAPE_BUILD_DIR (default ~/dev/fishtape/build), outside the repo.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${FISHTAPE_BUILD_DIR:-$HOME/dev/fishtape/build}"
DERIVED="${DERIVED_DATA_PATH:-$HOME/dev/fishtape/.derived}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
TEAM=9C68LPL6JA
ARCHIVE="$OUT/Fishtape-$BUILD_NUMBER.xcarchive"
mkdir -p "$OUT"

KEYFILE="$HOME/.appstoreconnect/api_key.json"
field() { node -e "const c=require(process.argv[1]);const v=String(c[process.argv[2]]||'');process.stdout.write(process.argv[2]==='key_filepath'?v.replace(/^~/,require('os').homedir()):v)" "$KEYFILE" "$1"; }
AUTH=(-allowProvisioningUpdates
  -authenticationKeyPath "$(field key_filepath)"
  -authenticationKeyID "$(field key_id)"
  -authenticationKeyIssuerID "$(field issuer_id)")

echo "== Fishtape TestFlight build $BUILD_NUMBER"
cd "$MOBILE"
npm ci --no-audit --no-fund > "$OUT/npm-$BUILD_NUMBER.log" 2>&1
FISHTAPE_ENV=production npm run sync 2>&1 | grep -E "copy-web|Sync finished"
grep -q '"https://app.fishtapehq.com"' ios/App/App/public/config.js || { echo "config.js is not production"; exit 1; }

echo "== App Store Connect app record"
node scripts/asc.mjs app

echo "== Archive (log: $OUT/archive-$BUILD_NUMBER.log)"
# Archived unsigned: automatic signing at archive time wants a development profile, which needs a
# registered iPhone or iPad on the team. The export step below signs for App Store distribution
# (no devices needed), with a certificate and profile Xcode manages through the API key.
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGNING_ALLOWED=NO \
  archive > "$OUT/archive-$BUILD_NUMBER.log" 2>&1 \
  || { grep -E "error:|BUILD|ARCHIVE" "$OUT/archive-$BUILD_NUMBER.log" | tail -20; exit 1; }
grep -E "ARCHIVE SUCCEEDED" "$OUT/archive-$BUILD_NUMBER.log"

echo "== Export and upload (log: $OUT/export-$BUILD_NUMBER.log)"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath "$OUT/export-$BUILD_NUMBER" "${AUTH[@]}" > "$OUT/export-$BUILD_NUMBER.log" 2>&1 \
  || { grep -E "error:|Error|EXPORT|Upload" "$OUT/export-$BUILD_NUMBER.log" | tail -20; exit 1; }
grep -E "EXPORT SUCCEEDED|Upload succeeded|Uploaded" "$OUT/export-$BUILD_NUMBER.log" | head -5

echo "== Waiting for App Store Connect to process build $BUILD_NUMBER"
node scripts/asc.mjs wait-build "$BUILD_NUMBER" "${WAIT_MINUTES:-25}"
node scripts/asc.mjs testflight "$BUILD_NUMBER" "TG Electrical"
echo "== Done: Fishtape 1.0 ($BUILD_NUMBER)"
