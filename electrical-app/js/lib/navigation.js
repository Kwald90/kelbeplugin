// Navigation choices use already permission-filtered, company-enabled modules.
// Keep locked modules visible so the existing route can explain plan availability.
export function navigationLabel(module) {
  return ({ dashboard: 'Today', clients: 'Customers' })[module.id] || module.title;
}

export function primaryNavigation(modules, role) {
  const preferred = ['electrician', 'apprentice'].includes(role)
    ? ['today', 'jobs', 'time', 'drawings']
    : role === 'foreman'
      ? ['today', 'jobs', 'schedule', 'time']
      : ['dashboard', 'clients', 'jobs', 'invoices'];
  const ids = [...preferred, ...modules.map((m) => m.id)];
  const seen = new Set();
  return ids.flatMap((id) => {
    const module = modules.find((m) => m.id === id);
    if (!module || seen.has(id)) return [];
    seen.add(id);
    return [module];
  }).slice(0, 4);
}
