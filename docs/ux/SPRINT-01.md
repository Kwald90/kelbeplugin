# Sprint 01: find the work and take the next step

Started: 2026-10-20. Status: implemented and validated locally.

## Scope

Implement labelled navigation, focused dashboard priorities, and an improved
estimate editor using existing routes, records, permissions, tax calculations,
sync, and integrations. The larger portal, job-overview, onboarding, and marketing
changes remain in the [roadmap](ROADMAP.md).

## Parallel ownership

| Agent | Isolated checkout | Owned files |
| --- | --- | --- |
| Navigation | `F:/Local/fishtape-ux-navigation` | `js/app.js`, `css/app.css`, `css/tokens.css`, `index.html`, optional navigation helper/test |
| Today | `F:/Local/fishtape-ux-today` | `js/modules/dashboard.js`, new `css/dashboard.css`, optional dashboard helper/test |
| Estimates | `F:/Local/fishtape-ux-estimates` | `js/modules/estimates.js`, new `css/estimate-experience.css`, optional estimate helper/test |
| Lead | Main checkout | Markdown plans, integration of stylesheet links and service worker, review and verification |

Paths in the ownership column are under `electrical-app/`. Agents commit locally;
the lead integrates each commit. Existing unrelated worktrees are left alone.

## Acceptance checklist

- [x] Desktop has visible navigation labels and a compact option.
- [x] Phone has labelled primary destinations and a complete More menu.
- [x] Existing permission/plan/switch gates retained in navigation; demo roles and switches exercised.
- [x] Dashboard leads with real actionable priorities and today's work.
- [x] Financial summaries respect existing access rules.
- [x] Estimate layout leads with customer/work and discloses pricing settings.
- [x] Staff approval wording does not imply a verified customer signature.
- [x] Accepted quote retains a clear create/open-job path.
- [x] Zoom and reduced-motion support improved.
- [x] New styles integrated with the app shell/cache.
- [x] Relevant tests and CSP checks recorded below.
- [x] Runtime/visual gaps explicitly recorded.

## Delivered

- Navigation: grouped labelled sidebar, saved compact setting, four role-relevant
  phone destinations and More. More retains unread/sync attention and focuses the
  first destination. Field home links respect module availability. Medium-width
  document layouts stack beside the expanded sidebar.
- Today: blockers, overdue balances, approved work missing a job/schedule, and
  unbilled T&M derived from existing records. Combined alerts are urgency-sorted.
  Secondary reporting is expandable. Crew names are visible. Financial alerts
  and links now respect role/module access.
- Estimates: customer/work-first editor, advanced pricing disclosure, visible tax
  totals/reasons, truthful Record approval dialog, job scheduling handoff, and
  protection against repeated local conversion. View-only controls prevent local
  editing, creation, status changes and emailing from preview.
- Integration: scoped stylesheets, cache revision, shared sheet initial-focus
  option, and read-only document-preview email guard.

Agent commits integrated locally: Today `be41f40`, Estimates `82a704f`, Navigation
`b236952`. The lead reviewed the combined code and screenshots and integrated
shared helpers/styles. Existing unrelated worktrees were not modified.

## Verification log

| Check | Result |
| --- | --- |
| Baseline `node --test electrical-app/tests/*.test.mjs` | 661 passed, 0 failed |
| Integrated `node --test electrical-app/tests/*.test.mjs` | 673 passed, 0 failed |
| `node electrical-app/tests/e2e/estimate-experience.e2e.mjs` | 19 browser behaviour assertions passed using an in-browser mocked store |
| `node electrical-app/tests/e2e/ux-navigation.e2e.mjs` | Demo shell passed: desktop collapse persistence; phone roles and touch targets; More reachability/focus/selection; disabled modules; populated estimates without overflow; canvas restoration; zero captured JS runtime errors |
| `node .github/scripts/check-csp.mjs` | 37 HTML and 177 JS files checked; 0 errors, 0 warnings |
| Syntax checks for edited modules/helpers and `git diff --check` | Passed |
| Screenshot review | 1366px desktop, 1100px desktop, 390px phone; saved previews linked in README |

The isolated navigation worktree initially lacked a native password dependency
for the full suite. The main checkout's integrated run includes that dependency
and all 673 tests pass.

### Remaining rollout checks

- Real signed-in tenant flows, downgraded plan scenarios, account/sync controls,
  and email/payment delivery were not exercised against a live API in this sprint.
- The navigation smoke bypasses the service worker; offline reload/update and
  rejected-sync badge behaviour need a signed-in integration test.
- Real iPhone/iPad, VoiceOver, large text, hardware keyboard and bright-light
  field testing remain. Headless Chrome screenshots do not establish these.
- Cross-device quote-to-job uniqueness is unchanged; local repeated conversion
  is guarded. Authenticated customer approval/versioning is future portal work.
- No measured customer usability baseline or pilot results are claimed.

## Release status

Local work only. No push or staging/production deployment performed. Customer
portal, broader job overview, onboarding, and marketing work remain on the roadmap.
