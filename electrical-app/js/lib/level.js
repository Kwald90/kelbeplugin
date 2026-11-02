// A phone level / inclinometer: lay the phone on a conduit leg to read its angle. The angle maths
// are pure (no DOM) so they can be tested; the sensor wrapper is split out and guards for no device.
//
// DeviceOrientationEvent gives beta (front-back tilt, °) and gamma (left-right tilt, °). Laid flat on
// a level surface both read ~0. We show pitch (along the phone's length) and roll (across it), each
// relative to a "zero" the user sets on a known-flat reference, plus the total tilt off level.

const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

/** Total tilt of the phone's flat face from horizontal, 0–90°, from beta/gamma in degrees. */
export function tilt(beta, gamma) {
  const b = ((Number(beta) || 0) * Math.PI) / 180;
  const g = ((Number(gamma) || 0) * Math.PI) / 180;
  const cos = Math.cos(b) * Math.cos(g);
  return r1((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
}

/**
 * Pitch, roll and total tilt relative to a calibration zero.
 * @param {number} beta @param {number} gamma @param {{beta?:number, gamma?:number}} [zero]
 */
export function reading(beta, gamma, zero = {}) {
  const pitch = (Number(beta) || 0) - (Number(zero.beta) || 0);
  const roll = (Number(gamma) || 0) - (Number(zero.gamma) || 0);
  return { pitch: r1(pitch), roll: r1(roll), tilt: tilt(pitch, roll) };
}

/** True once pitch and roll are within `within`° of the zero (the bubble is centred). */
export const isLevel = (rd, within = 0.5) => Math.abs(rd.pitch) <= within && Math.abs(rd.roll) <= within;

/** Is a device-orientation sensor available at all? */
export const hasSensor = () => typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;

/**
 * Ask for motion access. iOS 13+ Safari needs DeviceOrientationEvent.requestPermission() from a user
 * gesture; elsewhere (and in the app's web view) it's available without a prompt. Returns true if usable.
 */
export async function requestPermission() {
  if (!hasSensor()) return false;
  const E = window.DeviceOrientationEvent;
  if (typeof E.requestPermission === 'function') {
    try { return (await E.requestPermission()) === 'granted'; } catch { return false; }
  }
  return true;
}

/** Listen for orientation. cb(beta, gamma, alpha); returns an unsubscribe function. */
export function listen(cb) {
  if (!hasSensor()) return () => {};
  const handler = (e) => { if (e.beta != null || e.gamma != null) cb(e.beta, e.gamma, e.alpha); };
  window.addEventListener('deviceorientation', handler, true);
  return () => window.removeEventListener('deviceorientation', handler, true);
}
