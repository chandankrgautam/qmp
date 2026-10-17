/* Haptics on the phone: a soft tick when a complaint is sent, a double tick
   when it is done. The browser's vibration call stands in for the app's
   (Android HapticFeedbackConstants.CONFIRM / iOS UINotificationFeedback
   .success); where the device has none, nothing happens. Not tied to
   reduced motion: a tick is not movement on the screen, and the phone's own
   touch-feedback setting governs it. */

const buzz = (p: number | number[]) => {
  try { navigator.vibrate?.(p); } catch { /* no vibration on this device */ }
};
export const tick = () => buzz(12);
export const doubleTick = () => buzz([14, 90, 14]);
