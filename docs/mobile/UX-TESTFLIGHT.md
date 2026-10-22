# Sprint 02 iPhone and iPad update

Release preparation: 2026-10-22. Branch: `codex/ux-sprint-02`.
Review: [PR #2](https://github.com/Kwald90/kelbeplugin/pull/2).
Target: Fishtape 1.0, internal TestFlight group **TG Electrical**.

## Current status

Kelvin requested proceeding with the iOS update after being told the UX changes
had not been built or uploaded. The mobile web bundle is prepared locally with
the production API origin. No native archive or upload has been completed in
this release attempt: SSH to the documented build Mac, `192.168.0.9`, timed out.
The Mac must be reachable before signing and App Store Connect state can be
verified. No public App Store submission or server deployment has occurred.

The app loads its web screens from its installed bundle. Updating the website
alone does not update an installed iPhone or iPad binary; users need the new
TestFlight build after processing and assignment to the internal group.

## What to test

Suggested TestFlight notes:

> Job details now bring the next visit, crew, blockers and materials together.
> My day makes your clock status and saved work easier to understand. Company
> setup starts with the essentials, and quotes show a clearer next step.
> Please try these screens on both iPhone and iPad and report any clipped text,
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
  and Xcode project tool compatibility. Native archive validation is pending.

## Resume on the build Mac

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

Record the source SHA, marketing version, build number, archive path, Apple
processing result and internal group assignment here after success. A successful
upload alone does not prove processing or tester availability. Public App Store
review and release remain separate from this internal TestFlight update.
