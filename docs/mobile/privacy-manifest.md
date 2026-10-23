# iOS required-reason API declaration

Reviewed 2026-10-22. `mobile/ios/App/App/PrivacyInfo.xcprivacy` is included in the
App target's Copy Bundle Resources phase. It declares
`NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`.

`FishtapeGeofencePlugin.swift` uses `UserDefaults.standard` to retain the app's
shift id, start time and pending location events across app launches. Reads and
writes use the app-owned keys `ft.geofence.shift`, `ft.geofence.startedAt` and
`ft.geofence.events`. There is no suite, app group, managed configuration or
other app's defaults involved. This matches Apple's reason for app-private
defaults access. The declaration changes no location or retention behavior.

Apple requires an app to declare its own required-reason API use; a dependency's
manifest does not cover this native app code. The manifest must also be a target
resource, so merely placing it next to `Info.plist` is insufficient.

This is a narrow required-reason API fix, **not a completed app privacy review**.
It deliberately does not assert empty collected-data arrays or tracking answers.
The app handles and syncs business and location data. Before distribution,
review the full app and server data flow, complete the applicable collection
declarations and App Store Connect App Privacy answers, and check the manifests
from the resolved Capacitor packages. Existing location purpose strings remain
in `Info.plist`; those permission prompts are separate from this declaration.

## Validation

`cd mobile && npm test` parses the XML property list and the actual Xcode project,
and verifies that the App target copies the manifest from its App directory.
These checks run on Windows; they do not validate an Apple archive.

On 2026-10-22, the Mac simulator build and signed release build `20261023.25`
succeeded. The archived app's manifest passed `plutil` validation and an explicit
CA92.1 check before upload. Apple processed the build as VALID and made it
available for internal testing. This confirms packaging and processing, not a
complete privacy report or App Privacy questionnaire review; see the
[release record](UX-TESTFLIGHT.md).

On the build Mac, archive the intended release, check that
`Products/Applications/App.app/PrivacyInfo.xcprivacy` exists inside the archive,
generate Xcode's Privacy Report and validate the archive with Apple before upload.
Revisit the declarations whenever native API use or data handling changes.

## Apple references

- [Required reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)
- [Approved API reasons, including CA92.1](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitypereasons)
- [Adding a manifest to the app target and bundle](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk)
- [Describing collected data](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
