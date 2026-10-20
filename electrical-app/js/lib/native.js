// The Fishtape iOS app (Capacitor, mobile/) versus the browser.
//
// - Files: <a download> with a blob URL does nothing in WKWebView, so files are written with the
//   Filesystem plugin to the app's Documents folder (shown in the Files app under Fishtape) and handed
//   to the share sheet, which offers Save to Files, AirDrop, Mail, Messages and Print.
// - Secrets: the API session token and the shared-iPad device token live in the iOS Keychain
//   (FishtapeKeychain plugin), never in web storage. session.js uses them.
// - Printing: WKWebView ignores window.print(), so in the app window.print() goes to the FishtapePrint
//   plugin (the iOS print sheet, which also offers Save to Files as PDF). Installed on import.
// Plugins are reached through window.Capacitor.Plugins, which the native bridge fills in before the
// page loads; no bundler or @capacitor/* import is needed. In a browser isNativeApp() is false and
// nothing here runs.

const cap = () => globalThis.Capacitor || null;

/** True inside the Fishtape iOS app. */
export function isNativeApp() {
  try { return !!cap()?.isNativePlatform?.(); } catch { return false; }
}

function plugin(name) {
  const p = cap()?.Plugins?.[name];
  if (!p) throw new Error(`This version of the app is missing the ${name} plugin.`);
  return p;
}

// ---- files ----------------------------------------------------------------------

/** A name the iOS file system accepts: no slashes, colons or control characters. */
export function safeFileName(name) {
  const clean = String(name || '').replace(/[\\/:\u0000-\u001f\u007f]+/g, '-').replace(/^[.\s]+/, '').trim();
  return clean.slice(0, 120) || 'file';
}

/** Blob, ArrayBuffer, typed array or string -> base64 (no data: prefix). */
export async function toBase64(content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The share sheet was closed without picking anything. */
export function isShareCancel(e) {
  return /cancel/i.test(String(e?.message || e?.errorMessage || e || ''));
}

/**
 * Save a file in the app's Documents folder and open the share sheet for it.
 * Resolves to { uri, shared } (shared is false when the sheet was closed without a choice).
 */
export async function saveAndShare(filename, content, type) {
  const name = safeFileName(filename);
  const data = await toBase64(content, type);
  const { uri } = await plugin('Filesystem').writeFile({ path: name, data, directory: 'DOCUMENTS', recursive: true });
  try {
    await plugin('Share').share({ title: name, files: [uri] });
    return { uri, shared: true };
  } catch (e) {
    if (isShareCancel(e)) return { uri, shared: false };
    throw e;
  }
}

// ---- pages outside the app --------------------------------------------------------

/**
 * Open a page that isn't part of Fishtape, such as Stripe Checkout or the billing portal. On the
 * web it replaces this page, as before. In the iOS app it opens in a Safari sheet over the app
 * (Browser plugin), never inside the app's web view; `onClose` runs when the person closes it.
 */
export async function openExternal(url, { onClose, win = globalThis } = {}) {
  if (!isNativeApp()) { win.location.assign(url); return; }
  const u = new URL(String(url));
  if (u.protocol !== 'https:') throw new Error('Only https pages can be opened from the app.');
  const browser = plugin('Browser');
  if (onClose) {
    let handle = null;
    handle = await browser.addListener('browserFinished', () => {
      Promise.resolve(handle).then((h) => h?.remove?.()).catch(() => {});
      onClose();
    });
  }
  await browser.open({ url: u.href, presentationStyle: 'fullscreen' });
}

/**
 * Close the Safari sheet openExternal opened (the iOS app only), for example once the QuickBooks
 * connection changes while the person is still on Intuit's pages. Does nothing on the web, and
 * never throws: the sheet may already be closed.
 */
export async function closeExternal() {
  if (!isNativeApp()) return false;
  try { await plugin('Browser').close(); return true; } catch { return false; }
}

// ---- Keychain -------------------------------------------------------------------

/** Keys the FishtapeKeychain plugin accepts. */
export const SECRET_KEYS = ['session', 'device'];

/** A secret from the iOS Keychain, or null. */
export async function getSecret(key) {
  const r = await plugin('FishtapeKeychain').get({ key });
  return typeof r?.value === 'string' && r.value ? r.value : null;
}

/** Save a secret in the iOS Keychain (this device only, not backed up to other devices). */
export async function setSecret(key, value) {
  await plugin('FishtapeKeychain').set({ key, value: String(value) });
}

export async function removeSecret(key) {
  await plugin('FishtapeKeychain').remove({ key });
}

// ---- printing -------------------------------------------------------------------

let printing = false;
let ownEvent = false;

/**
 * window.print() for the iOS app.
 *
 * Screens print the way browsers expect: mount a print-only copy, call print(), then remove the copy
 * on 'afterprint' or with setTimeout(done, …) right after print() returns. A browser's print() blocks
 * until its dialog closes; the iOS print sheet can't block JavaScript, so timers set in the rest of
 * the calling task are held until the sheet closes, and 'beforeprint'/'afterprint' fire around it.
 * WebKit also fires those events each time the sheet lays the page out (the preview, a paper change);
 * installNativePrint() stops them while the sheet is open, or the copy would be gone before printing.
 * The sheet prints the live web view (print CSS applies), and its share button saves a PDF.
 */
export function nativePrint(win = globalThis) {
  const p = win.Capacitor?.Plugins?.FishtapePrint;
  if (!p || printing) return;
  printing = true;
  const held = [];
  const realSetTimeout = win.setTimeout;
  win.setTimeout = (fn, ms, ...args) => { held.push([fn, ms, args]); return 0; };
  queueMicrotask(() => { win.setTimeout = realSetTimeout; });
  const fire = (type) => {
    ownEvent = true;
    try { win.dispatchEvent(new Event(type)); } catch { /* no event target */ } finally { ownEvent = false; }
  };
  fire('beforeprint');
  const done = () => {
    printing = false;
    fire('afterprint');
    for (const [fn, ms, args] of held) realSetTimeout(fn, ms, ...args);
  };
  Promise.resolve()
    .then(() => p.print({ jobName: String(win.document?.title || 'Fishtape').slice(0, 100) }))
    .then(done, (e) => { done(); console.error('Printing failed', e); });
}

/** Stop WebKit's own print events while our sheet is open (see nativePrint). */
function holdWebKitPrintEvents(e) {
  if (printing && !ownEvent) e.stopImmediatePropagation();
}

/** Route window.print() to the iOS print sheet. Does nothing outside the app. */
export function installNativePrint(win = globalThis) {
  if (!isNativeApp() || win.__fishtapeNativePrint) return false;
  win.__fishtapeNativePrint = true;
  win.print = () => nativePrint(win);
  // Capturing, and added before any screen's listener, so it runs first.
  win.addEventListener?.('beforeprint', holdWebKitPrintEvents, true);
  win.addEventListener?.('afterprint', holdWebKitPrintEvents, true);
  return true;
}

installNativePrint();
