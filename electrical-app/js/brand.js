// Product name in one place. The name is not final until the domain and a
// CIPO trademark search are done, so nothing else hard-codes it.
export const BRAND = {
  name: 'Fishtape',
  backupTag: 'fishtape',
  legacyBackupTags: ['kelbe-circuit'],
  // Canonical production origin for deep links printed on paper (e.g. the QR code on a
  // panel schedule), so a code scanned a year later opens the real app, not whatever host
  // happened to print it. Code falls back to location.origin when this is empty.
  appOrigin: 'https://app.fishtapehq.com',
};
