/**
 * Haptic feedback helpers.
 *
 * Wraps `navigator.vibrate`; silently no-ops if unavailable (iOS Safari,
 * old browsers, desktop, server-side render).
 */

type VibratePattern = number | number[];

/** Fire a vibration. Returns true if the API accepted the call. */
export function vibrate(pattern: VibratePattern = 10): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & {
    vibrate?: (pattern: VibratePattern) => boolean;
  };
  if (typeof nav.vibrate !== 'function') return false;
  try {
    return nav.vibrate(pattern);
  } catch {
    return false;
  }
}

/** Light tap — e.g. button press. */
export const tap = (): boolean => vibrate(10);

/** Medium tap — e.g. swipe gesture crossing a threshold. */
export const bump = (): boolean => vibrate(18);

/** Success pattern. */
export const success = (): boolean => vibrate([10, 40, 10]);

/** Error pattern. */
export const error = (): boolean => vibrate([30, 50, 30]);
