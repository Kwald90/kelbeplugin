// Fishtape sales catalog — the only script: wire the Print button (served same-origin, so
// window.print() works here, unlike inside an embedded viewer). No inline handlers (CSP).
document.getElementById('printBtn')?.addEventListener('click', () => window.print());
