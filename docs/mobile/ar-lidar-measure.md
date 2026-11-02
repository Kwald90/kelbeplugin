# AR / LiDAR distance measure — how it fits together and how to finish it

Fishtape measures real-world distances with the camera: tap points in AR and get the length in
metres. In the iOS app this is a native **ARKit** plugin that uses **LiDAR scene reconstruction**
when the device has it (iPhone/iPad Pro), and falls back to plane / feature-point raycasting on
non-LiDAR devices. On the web it falls back to WebXR (ARCore Android) or a clear "not available"
message. Nothing here can throw in a plain browser.

This doc is the short "how to finish and test it" guide. The deep reference (frame loop, raycast
order, snapshot, privacy) is in [`docs/mobile/README.md`](README.md) under **FishtapeMeasure**, and
the field write-up is in [`docs/field/wire-runs.md`](../field/wire-runs.md).

> **The native (Swift) side is written but UNBUILT and UNTESTED here.** It cannot be compiled on
> this PC — ARKit + Capacitor need Xcode on a Mac. Everything below marked **[Mac]** must be done
> and tested on a LiDAR-equipped iPhone or iPad. The JS/web side is tested (`node --test`) and its
> fallback is safe.

## What is already in the repo

| Piece | Path |
| --- | --- |
| Capacitor plugin (CAPPlugin + CAPBridgedPlugin) | `mobile/ios/App/App/FishtapeMeasure/FishtapeMeasurePlugin.swift` |
| Full-screen AR measuring view (ARKit/SceneKit, LiDAR mesh when available) | `mobile/ios/App/App/FishtapeMeasure/MeasureViewController.swift` |
| Length formatting (matches the web `fmtLength`) | `mobile/ios/App/App/FishtapeMeasure/MeasureFormat.swift` |
| Plugin registration | `mobile/ios/App/App/MainViewController.swift` → `capacitorDidLoad()` registers `FishtapeMeasurePlugin()` |
| Xcode membership | `mobile/ios/App/App.xcodeproj/project.pbxproj` already references all three Swift files and the `FishtapeMeasure` group |
| `NSCameraUsageDescription` | `mobile/ios/App/App/Info.plist` (already present) |
| JS wrapper (native → WebXR → none) | `electrical-app/js/lib/ar-measure.js` |
| Web entry point — Wire Runs | `electrical-app/js/modules/wireruns.js` ("AR tape") |
| Web entry point — Bending (new) | `electrical-app/js/modules/bending.js` ("Measure (AR)" button) |

### The JS ↔ native contract

`window.Capacitor.Plugins.FishtapeMeasure`:

```
isAvailable() -> { available: boolean }        // ARWorldTrackingConfiguration.isSupported
measurePath({ units: 'metric' | 'imperial' })
  -> { totalM, segments: [{ lengthM }], points: [{ x, y, z }], snapshot: 'data:image/jpeg;base64,...' }
     rejects with code 'cancelled' when the user backs out
```

Lengths are always metres in ARKit world space; `units` only sets the labels drawn in the AR view.
LiDAR is used automatically: `startSession()` in `MeasureViewController` sets
`config.sceneReconstruction = .mesh` when `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)`
is true, and the raycast prefers `.estimatedPlane` (which follows the mesh) on those devices.

## The web side (done, tested here)

`electrical-app/js/lib/ar-measure.js` chooses a back end: **native** (the plugin), else **webxr**,
else **none** with a plain-words reason. `getArSupport()` reports which; `measurePath()` runs it. The
new Bending entry point (`bending.js`):

- adds a **Measure (AR)** button next to **Level** on the Pipe-bending screen;
- primes `getArSupport()` when the screen renders, so the tap that starts WebXR keeps its user gesture;
- on tap, runs `measurePath({ units })` and shows the total length in a sheet (both unit systems) with
  **Copy length** (copies the formatted value to paste into any length field) and **Measure again**;
- when no AR is available, opens a sheet explaining it needs the Fishtape app on a LiDAR iPhone/iPad
  (or ARCore Chrome on Android) and that the length can be typed in instead.

Guarding: `measurePath` only reaches the plugin when `window.Capacitor.Plugins.FishtapeMeasure`
exists, so on this PC / a normal browser the button shows the "not available" sheet and never throws.

## Finishing on the Mac — exact steps

The files are already in the Xcode project and `Info.plist`, so a normal build picks them up. Do this
on Kelvin's Mac (SSH `kelvin@192.168.0.9`; see `docs/mobile/fishtape-ios-build-mac` notes in memory
and `mobile/scripts/testflight.sh`).

1. **[Mac]** Get the branch and the web build synced into the native app:
   ```sh
   git pull origin claude/electrical-concept-app-h4qz12
   cd mobile
   npm install
   npx cap sync ios        # testflight.sh also runs this; copies electrical-app/ → www and updates pods
   ```
2. **[Mac] Confirm the camera key is present** (it already is — do not duplicate it):
   `mobile/ios/App/App/Info.plist` →
   ```xml
   <key>NSCameraUsageDescription</key>
   <string>Fishtape uses the camera to measure wire runs along walls and conduit, and to take photos for your jobs.</string>
   ```
   ARKit is deliberately **not** in `UIRequiredDeviceCapabilities`, so non-AR devices can still
   install; `isAvailable()` gates it at runtime.
3. **[Mac] If the three Swift files are ever NOT in the project** (they are now, per `project.pbxproj`):
   open `mobile/ios/App/App.xcodeproj` in Xcode, right-click the **App** group → *Add Files to "App"*,
   add the `FishtapeMeasure/` folder, and tick **Copy items if needed** off and **App** target on.
   Verify they appear under *App target → Build Phases → Compile Sources*.
4. **[Mac] Build to a LiDAR device** (iPhone/iPad Pro) from Xcode, or ship a TestFlight build:
   ```sh
   cd mobile && ./scripts/testflight.sh      # bundles web, cap sync, archives, uploads to App Store Connect
   ```
   (The keychain unlock password and the upload flow are in the iOS-build memory note.)

## What to test on-device (needs a Mac build + a LiDAR iPhone/iPad)

- **Permission**: first run prompts for camera; denying shows the "Camera access is off" alert with
  *Open Settings*, and `measurePath` rejects with `camera_denied` (JS shows the message, never throws).
- **LiDAR vs non-LiDAR**: on a Pro device, points land on plain drywall (mesh); on a non-LiDAR device
  it still works via detected/estimated planes, a bit less steady.
- **Simulator / non-AR devices**: `isAvailable()` returns `available: false`, so the button shows the
  "not available" sheet.
- **Bending → Measure (AR)**: tap two points, Done, and confirm the sheet shows the distance and
  **Copy length** copies a value that parses back into a length field. Accuracy: check a known length
  (e.g. a 4 ft / 1220 mm sheet) against a tape; AR lengths are estimates.
- **Cancel**: backing out rejects with `cancelled`; the JS treats it as a no-op (no error toast).

## Status

- Web/JS side: **done and verified** here — `node --test electrical-app/tests/*.test.mjs` (966 pass),
  `node .github/scripts/check-csp.mjs` (0 errors, no new origins).
- Native Swift/ARKit side: **written, not compiled or run.** Requires Xcode on a Mac and a LiDAR
  device for the final build and on-device testing (steps above).
