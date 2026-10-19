// Compliance & security for HQ: the controls list (compliance/controls.yaml, written by
// the platform workstream) and the access review (who holds power, with MFA status).
import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './hq-yaml.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const str = (v, n = 300) => (v == null ? null : String(v).slice(0, n));
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'object' && x ? (x.url || x.path || x.href || JSON.stringify(x)) : String(x))).map((s) => s.slice(0, 500));

/**
 * One control in the shape the HQ page shows:
 * { id, title, tsc: [], owner, frequency, evidence, status, links: [], description? }
 */
export function normalizeControl(c, i) {
  if (!c || typeof c !== 'object') return { id: `#${i + 1}`, title: String(c ?? ''), tsc: [], owner: null, frequency: null, evidence: [], status: 'unknown', links: [] };
  return {
    id: str(c.id ?? c.key ?? `#${i + 1}`, 60),
    title: str(c.title ?? c.name ?? '', 300),
    description: str(c.description ?? c.summary, 2000),
    tsc: list(c.tsc ?? c.criteria),
    owner: str(c.owner, 120),
    frequency: str(c.frequency, 60),
    evidence: list(c.evidence),
    status: str(c.status ?? 'unknown', 40),
    links: list(c.links),
    lastReviewed: str(c.last_reviewed ?? c.lastReviewed ?? c.reviewed, 40),
  };
}

/**
 * Read the controls file. Never throws: a missing or broken file is a state the page shows.
 * @returns {{ found: boolean, file: string, controls: object[], error?: string, updatedAt?: string, summary?: object }}
 */
export function loadControls(file) {
  const shown = relative(REPO_ROOT, file).replace(/\\/g, '/') || file;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { found: false, file: shown, controls: [] }; }
  let doc;
  try { doc = parseYaml(text); } catch (e) { return { found: true, file: shown, controls: [], error: `Could not read the file: ${String(e.message).slice(0, 200)}` }; }
  const raw = Array.isArray(doc) ? doc : Array.isArray(doc?.controls) ? doc.controls : null;
  if (!raw) return { found: true, file: shown, controls: [], error: 'The file has no "controls:" list.' };
  const controls = raw.map(normalizeControl);
  const byStatus = {};
  for (const c of controls) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  let updatedAt = null;
  try { updatedAt = statSync(file).mtime.toISOString(); } catch { /* ignore */ }
  return { found: true, file: shown, controls, updatedAt, summary: { total: controls.length, byStatus } };
}

const DAY = 86_400_000;

/** Findings for one person in the access review. */
export function accessFindings(p, now = Date.now()) {
  const out = [];
  if (!p.mfaEnrolled) out.push('No two-step sign-in');
  if (p.status && p.status !== 'active') out.push(`Account ${p.status}`);
  if (!p.lastLoginAt) out.push('Never signed in');
  else if (now - new Date(p.lastLoginAt).getTime() > 90 * DAY) out.push('No sign-in for 90+ days');
  return out;
}

/** HQ staff and every company's owners/admins, with MFA status and last sign-in. */
export async function accessReview(c) {
  const staff = (await c.query(
    `SELECT u.id, u.display_name, u.email, u.platform_role, u.status, u.last_login_at, u.created_at,
            EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa
       FROM users u WHERE u.platform_role IS NOT NULL ORDER BY u.display_name`)).rows;
  const admins = (await c.query(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status, m.id AS membership_id, m.role, m.status AS membership_status,
            u.id AS user_id, u.display_name, u.email, u.status AS user_status, u.last_login_at,
            EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa
       FROM memberships m JOIN users u ON u.id = m.user_id JOIN tenants t ON t.id = m.tenant_id
      WHERE m.role IN ('owner', 'admin') AND t.status <> 'closed'
      ORDER BY t.name, m.role DESC, u.display_name`)).rows;
  const now = Date.now();
  const staffOut = staff.map((s) => {
    const p = { userId: s.id, name: s.display_name, email: s.email, role: s.platform_role, status: s.status, lastLoginAt: s.last_login_at, mfaEnrolled: s.mfa };
    return { ...p, findings: accessFindings(p, now) };
  });
  const adminOut = admins.map((a) => {
    const p = {
      tenantId: a.tenant_id, tenantName: a.tenant_name, tenantStatus: a.tenant_status, membershipId: a.membership_id, role: a.role,
      status: a.membership_status === 'active' ? a.user_status : a.membership_status, userId: a.user_id, name: a.display_name, email: a.email,
      lastLoginAt: a.last_login_at, mfaEnrolled: a.mfa,
    };
    return { ...p, findings: p.status === 'invited' ? ['Invite not accepted yet'] : accessFindings(p, now) };
  });
  const flagged = [...staffOut, ...adminOut].filter((p) => p.findings.length).length;
  return { staff: staffOut, tenantAdmins: adminOut, summary: { staff: staffOut.length, tenantAdmins: adminOut.length, flagged, withoutMfa: [...staffOut, ...adminOut].filter((p) => !p.mfaEnrolled).length } };
}
