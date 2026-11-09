// Quick-find index + ranking for the global search overlay (the shell's openSearch in app.js).
// Pure: given the module and switch registries it returns flat, searchable entries and ranks them
// against a typed query. The shell supplies the access/enabled predicates and the label function;
// navigation is a plain `target` hash string the shell routes, so nothing here touches the DOM.

/**
 * Flat searchable entries: every screen the person can open, and (optionally) every module switch
 * they can change. Each entry: { kind:'screen'|'option', id, label, hint, icon, enabled, target, terms }.
 */
export function searchEntries({
  modules = [], switches = [], groups = {},
  canAccess = () => true, isEnabled = () => true, isSwitchOn = () => true,
  label = (m) => m.title, includeOptions = true,
} = {}) {
  const out = [];
  for (const m of modules) {
    if (m.hidden || !canAccess(m.perm)) continue;
    const name = label(m) || m.title || m.id;
    out.push({
      kind: 'screen', id: m.id, label: name, hint: groups[m.group] || '', icon: m.icon || 'file-text',
      enabled: isEnabled(m.id), target: m.id,
      terms: `${name} ${m.id} ${groups[m.group] || ''}`.toLowerCase(),
    });
  }
  if (includeOptions) {
    for (const sw of switches) {
      if (sw.hidden) continue;
      out.push({
        kind: 'option', id: sw.id, label: sw.label || sw.id, hint: `${groups[sw.group] || ''} · option`, icon: 'sliders',
        enabled: isSwitchOn(sw.id), target: `settings?section=modules&find=${encodeURIComponent(sw.id)}`,
        terms: `${sw.label || ''} ${sw.desc || ''} ${groups[sw.group] || ''} option setting ${sw.id}`.toLowerCase(),
      });
    }
  }
  return out;
}

/**
 * Rank entries against a query. Every whitespace token must appear somewhere in the entry's terms
 * (AND match); the score then favours a label that equals, starts with, or merely contains the query,
 * with screens a hair above options. An empty query returns the first `limit` entries unchanged.
 */
export function rankEntries(entries, query, { limit = 50 } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries.slice(0, limit);
  const toks = needle.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const e of entries) {
    if (!toks.every((t) => e.terms.includes(t))) continue;
    const lab = e.label.toLowerCase();
    let score = 0;
    if (lab === needle) score += 100;
    else if (lab.startsWith(needle)) score += 60;
    else if (lab.includes(needle)) score += 30;
    if (e.kind === 'screen') score += 5;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label));
  return scored.map((x) => x.e).slice(0, limit);
}
