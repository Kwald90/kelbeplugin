# Sprint 02 iPhone and iPad update

Release preparation: 2026-10-22. Branch: `codex/ux-sprint-02`.
Review: [PR #2](https://github.com/Kwald90/kelbeplugin/pull/2).
Target: Fishtape 1.0, internal TestFlight group **TG Electrical**.

## Current status

Kelvin requested proceeding with the iOS update. The build Mac became reachable
after the initial connection timeout. The production bundle was built and
signed, and Apple accepted the upload with no errors. Processing is **VALID**,
and Apple reports **IN_BETA_TESTING**. Membership in the internal **TG Electrical**
group was verified; the group has one tester. Testing notes were saved and read
back in the app's `en-CA` locale. No public App Store submission or server
deployment has occurred.

| Release fact | Value |
| --- | --- |
| Marketing version / build | `1.0 (20261023.25)` |
| Source commit | `292ff141f766f541410b6085d6af290bfeb8173a` |
| Apple build ID | `818a4fe6-c2fc-4570-8e5e-7ee4b55c37a2` |
| Availability verified | `2026-10-23T00:33:37Z` (2026-10-22 in America/Edmonton) |
| App Store Connect app | FishTapeHQ, `6824723652`, bundle `com.fishtapehq.app` |
| API | `https://app.fishtapehq.com` |
| Build checkout | `~/dev/fishtape/releases/ux-sprint-02-292ff14` on the Mac |
| Archive | `~/dev/fishtape/build/ux2-292ff14/Fishtape-20261023.25.xcarchive` |
| Signed IPA | `~/dev/fishtape/build/ux2-292ff14/export-20261023.25/App.ipa` |

The build number uses UTC; this release work occurred on 2026-10-22 in
America/Edmonton. The Mac's original checkout was preserved; the release used
a detached worktree at the tested commit.

The app loads its web screens from its installed bundle. Updating the website
alone does not update an installed iPhone or iPad binary; users need the new
TestFlight build after processing and assignment to the internal group.

## What to test

Published TestFlight notes:

> Job details now bring the next visit, crew, blockers and materials together.
> My day makes your clock status and saved work easier to understand. Company
> setup starts with the essentials, and quotes show a clearer next step.
> Please try these screens on iPhone and iPad and report clipped text,
> confusing actions, or work that does not save as expected.

Device acceptance checks:

- Open an existing job and find the next visit, assigned crew and blockers.
- In My day, start a task and confirm payroll clock status does not change.
- Use airplane mode, save permitted field work, reconnect and check sync status.
- Create a quote and check pricing, approval guidance and the job handoff.
- Complete essential setup; verify deferred steps still appear as unfinished.
- Check sign-in persistence, PDF sharing, printing and AR measurement.
- Check location permissions and arrival/departure behavior while clocked in;
  confirm clocking out stops monitoring. Use a test company for these checks.

## Verified before the native build

- Existing UX commit `3e178a3` passed GitHub CI and security checks: 803 PWA tests,
  1,001 server tests and six mobile tests. Subsequent mobile release fixes require
  their own checks; earlier green checks do not cover new commits.
- Production `/api/readyz` returned HTTP 200 on 2026-10-22.
- Production `/api/v1/status` returned HTTP 200 with JSON content type. These
  public probes establish reachability, not authenticated sign-in or sync.
- `FISHTAPE_ENV=production npm run copy:web` generated 253 files, about 5.3 MB,
  targeting `https://app.fishtapehq.com`.
- All ten Sprint 02 module/helper/stylesheet files match the source byte for
  byte. All four stylesheet references are present in the generated index.
  Tests and the service worker are excluded from the mobile bundle.
- Release helper fixes preserve existing provisioning profiles and require an
  internal TestFlight group before assigning a build.
- The app now includes its own UserDefaults required-reason manifest; see the
  [evidence and limits](privacy-manifest.md). This does not certify the app's
  complete privacy disclosures.
- Combined mobile suite after these fixes: **14 passed, 0 failed**. It checks
  release mutation boundaries, manifest XML and target packaging, API config,
  and Xcode project tool compatibility. Native results are recorded below.

## Native verification

- All 14 mobile tests passed on the Mac, followed by production Capacitor sync.
- Xcode 26.3 simulator build succeeded. The generated app's privacy manifest
  passed `plutil` validation.
- The app process launched in a new iPhone 17 Pro / iOS 26.3 simulator. An iOS
  keyboard tutorial covered the captured screen, so this establishes launch,
  not a completed visual or authenticated workflow check. The temporary
  simulator was shut down and deleted after the check.
- Release archive and signed IPA export succeeded. Before upload, an additional
  guard checked the archive's CA92.1 manifest entry, compared all ten UX assets
  against source, verified the production API origin, and confirmed that the
  service worker was excluded. All passed.
- Apple upload completed without errors. Logs are in the Mac build directory
  listed above; credentials are not included in this record.
- Apple completed processing with `usesNonExemptEncryption: false`; internal
  state is `IN_BETA_TESTING`. The build appears in TG Electrical's builds list.
  The external state is `READY_FOR_BETA_SUBMISSION`; no external review was
  submitted. Safe API verification metadata is saved as `release-verification.json`
  alongside the Mac build logs and in the local release evidence directory.
- Source commit `292ff14` passed both push and PR CI/security checks. The full
  Linux server suite passed 1,001 tests with no failures or skips.

## Repeat the build

Use a separate checkout for the release candidate so existing Mac work is
preserved. Fetch the reviewed branch, record its full commit SHA, and compare
that SHA with the PR's tested head before building. Do not reset or overwrite
an existing dirty checkout.

From that checkout on the Mac:

```sh
export PATH="$HOME/.local/node/bin:$PATH"
cd mobile
npm ci --no-audit --no-fund
npm test
FISHTAPE_ENV=production npm run sync
npm run build:sim
node scripts/asc.mjs app
cd ..
mobile/scripts/testflight.sh
```

The script uses the existing Mac signing setup and App Store Connect key without
printing credentials. If the login keychain is locked, unlock it locally on the
Mac; do not send its password in chat. Use a new build number for each upload.
Check the resulting archive includes the app's privacy manifest. Verify the
current App Privacy answers cover location use; the manifest does not replace
those answers.

For subsequent builds, record the source SHA, marketing version, build number,
archive path, Apple processing result and internal group assignment. A successful
upload alone does not prove processing or tester availability. Public App Store
review and release remain separate from this internal TestFlight update.
