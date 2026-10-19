// The Fishtape iOS app (Capacitor, mobile/) versus the browser.
//
// In the app, <a download> with a blob URL does nothing in WKWebView, so files are written with the
// Filesystem plugin to the app's Documents folder (shown in the Files app under Fishtape) and handed
// to the share sheet, which offers Save to Files, AirDrop, Mail, Messages and Print.
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
