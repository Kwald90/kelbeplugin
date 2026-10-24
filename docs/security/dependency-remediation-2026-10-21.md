# Mobile build dependency remediation

The dependency job for commit `0e1136c` failed because OSV Scanner 2.7.0 found
`GHSA-w5hq-g745-h8pq` in `uuid@7.0.3`, a development dependency in
`mobile/package-lock.json`. The scanner downloaded and passed its checksum;
its invocation was successful and correctly returned a finding.

The dependency chain was `@capacitor/cli@8.5.3` → `xcode@3.0.1` → `uuid@7.0.3`.
The [upstream advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)
describes missing output-buffer bounds checks in the v3/v5/v6 APIs. The
[11.1.1 release](https://github.com/uuidjs/uuid/releases/tag/v11.1.1) backports
the fix and retains CommonJS support.

## Change and scope

Override only `xcode`'s UUID dependency to exactly `11.1.1` in the mobile
manifest, and regenerate its lockfile. Capacitor and Xcode remain at their
existing versions. Xcode 3.0.1 uses `require('uuid').v4()` to generate uppercase,
24-character hexadecimal project identifiers; that interface remains available.
Although Xcode's inspected call uses v4 rather than the affected buffer APIs,
the vulnerable package is removed instead of suppressing the advisory.

Remove or reconsider the override when the installed Capacitor CLI dependency
chain no longer selects a vulnerable UUID release. Run the committed Xcode
compatibility tests before changing this override.

The failed job inspected both npm lockfiles, the Swift `Package.resolved`, and
vendored PDF.js metadata; UUID was its only finding. Server production
`npm audit` was already clean. No other manifest, lockfile, scanner exclusion,
or production runtime dependency needs a change for this finding.

## Validation

- `cd mobile && npm ci --ignore-scripts --no-audit`: installs the committed tree.
- `npm ls uuid`: resolves `xcode@3.0.1` to overridden `uuid@11.1.1`.
- `npm audit --audit-level=high`: zero vulnerabilities, including development dependencies.
- `npm test`: web configuration tests plus Xcode/UUID regression tests.
- `node node_modules/@capacitor/cli/bin/capacitor --version`: reports `8.5.3`.
- Checksum-verified OSV Scanner `2.7.0`, `scan source --recursive .` at the
  repository root: exit 0, no issues across the same four extraction sources.

The regression parses the real checked-in Xcode project, generates 1,000 distinct
IDs with Xcode's consumer, adds a group, writes and reparses a temporary project,
and verifies the fixed malformed-buffer behavior. It never writes to the real
project. These Windows checks do not replace a macOS native build before an
iOS release.
