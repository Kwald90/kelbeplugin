#!/bin/bash
# Build the Fishtape iOS app against production and upload it to TestFlight. Run on the build Mac,
# in Terminal or over SSH:
#   mobile/scripts/testflight.sh            (from anywhere in the repo)
# Steps: npm ci, sync with FISHTAPE_ENV=production, check the App Store Connect app record,
# archive unsigned, make an App Store profile for the distribution certificate in the login
# keychain, export signed with that certificate, upload, wait for processing, put the build in the
# internal TestFlight group "TG Electrical".
#
# Signing (what works over SSH on this Mac):
# - Archived unsigned: automatic signing at archive time wants a development profile, which needs a
#   registered iPhone or iPad, and automatic signing at export wants to mint a cloud certificate.
# - Exported with manual signing: the certificate is pinned by SHA-1 because a same-named
#   "Apple Distribution" certificate also sits in fastlane's locked temporary keychain.
# - codesign needs the login keychain unlocked (errSecInternalComponent otherwise). Over SSH, unlock
#   it first: security unlock-keychain ~/Library/Keychains/login.keychain-db (asks for the password).
#
# Build number: CURRENT_PROJECT_VERSION=$BUILD_NUMBER (default: UTC date.time, e.g. 20261020.745,
# always increasing; each part fits the 32-bit integers App Store Connect compares).
# Marketing version comes from MARKETING_VERSION in the Xcode project (1.0).
# The API key is read from ~/.appstoreconnect/api_key.json inside this script and never printed.
# Output goes to $FISHTAPE_BUILD_DIR (default ~/dev/fishtape/build), outside the repo.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${FISHTAPE_BUILD_DIR:-$HOME/dev/fishtape/build}"
DERIVED="${DERIVED_DATA_PATH:-$HOME/dev/fishtape/.derived}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d).$((10#$(date -u +%H%M)))}"
TEAM=9C68LPL6JA
BUNDLE_ID=com.fishtapehq.app
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
ARCHIVE="$OUT/Fishtape-$BUILD_NUMBER.xcarchive"
EXPORT="$OUT/export-$BUILD_NUMBER"
mkdir -p "$OUT"

KEYFILE="$HOME/.appstoreconnect/api_key.json"
field() { node -e "const c=require(process.argv[1]);process.stdout.write(String(c[process.argv[2]]||''))" "$KEYFILE" "$1"; }

# Drop fastlane's leftover temporary keychain from the search list: it is permanently locked and,
# being ahead of the login keychain, makes codesign fail with "locked" even after the login
# keychain is unlocked. Leave only the (user-unlockable) login keychain and the system keychain.
# This needs no password and is what the long-working builds relied on.
security list-keychains -d user -s "$LOGIN_KEYCHAIN" /Library/Keychains/System.keychain >/dev/null 2>&1 || true

# The distribution certificate in the login keychain (override with SIGNING_CERT=<sha1>).
CERT="${SIGNING_CERT:-$(security find-identity -v -p codesigning "$LOGIN_KEYCHAIN" | awk -v t="($TEAM)" '/"Apple Distribution: / && index($0, t) {print $2; exit}')}"
[ -n "$CERT" ] || { echo "No Apple Distribution certificate for team $TEAM in the login keychain"; exit 1; }
# A locked keychain fails here (a test signature) instead of after a 10-minute archive.
# (show-keychain-info is no test: over SSH it refuses even when the keychain is unlocked.)
PROBE="$(mktemp -d)/probe"; cp /usr/bin/true "$PROBE"
codesign -f -s "$CERT" "$PROBE" > /dev/null 2>&1 \
  || { echo "codesign can't use the login keychain (locked): unlock it in this same SSH session with  security unlock-keychain $LOGIN_KEYCHAIN  then run this again"; exit 1; }
rm -rf "$(dirname "$PROBE")"

echo "== Fishtape TestFlight build $BUILD_NUMBER"
cd "$MOBILE"
npm ci --no-audit --no-fund > "$OUT/npm-$BUILD_NUMBER.log" 2>&1
FISHTAPE_ENV=production npm run sync 2>&1 | grep -E "copy-web|Sync finished"
grep -q '"https://app.fishtapehq.com"' ios/App/App/public/config.js || { echo "config.js is not production"; exit 1; }

echo "== App Store Connect app record"
node scripts/asc.mjs app

echo "== Archive (log: $OUT/archive-$BUILD_NUMBER.log)"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGNING_ALLOWED=NO \
  archive > "$OUT/archive-$BUILD_NUMBER.log" 2>&1 \
  || { grep -E "error:|BUILD|ARCHIVE" "$OUT/archive-$BUILD_NUMBER.log" | tail -20; exit 1; }
grep -E "ARCHIVE SUCCEEDED" "$OUT/archive-$BUILD_NUMBER.log"

echo "== App Store profile for certificate $CERT"
PROFILE="$(node scripts/asc.mjs profile "$CERT")"
OPTIONS="$OUT/ExportOptions-$BUILD_NUMBER.plist"
cp ios/ExportOptions.plist "$OPTIONS"
/usr/libexec/PlistBuddy -c "Add :signingCertificate string $CERT" \
  -c "Add :provisioningProfiles dict" -c "Add :provisioningProfiles:$BUNDLE_ID string $PROFILE" "$OPTIONS"

echo "== Export (log: $OUT/export-$BUILD_NUMBER.log)"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTIONS" \
  -exportPath "$EXPORT" > "$OUT/export-$BUILD_NUMBER.log" 2>&1 \
  || { grep -E "error:|Error|EXPORT" "$OUT/export-$BUILD_NUMBER.log" | tail -20; exit 1; }
IPA="$(ls "$EXPORT"/*.ipa | head -1)"
echo "exported $IPA"

echo "== Upload (log: $OUT/upload-$BUILD_NUMBER.log)"
# altool finds the key as ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$(field key_id)" --apiIssuer "$(field issuer_id)" \
  > "$OUT/upload-$BUILD_NUMBER.log" 2>&1 \
  || { grep -iE "error|fail" "$OUT/upload-$BUILD_NUMBER.log" | tail -20; exit 1; }
grep -iE "UPLOAD SUCCEEDED|Delivery UUID|No errors" "$OUT/upload-$BUILD_NUMBER.log" | head -3

echo "== Waiting for App Store Connect to process build $BUILD_NUMBER"
node scripts/asc.mjs wait-build "$BUILD_NUMBER" "${WAIT_MINUTES:-25}"
node scripts/asc.mjs testflight "$BUILD_NUMBER" "TG Electrical"
echo "== Done: Fishtape 1.0 ($BUILD_NUMBER)"
