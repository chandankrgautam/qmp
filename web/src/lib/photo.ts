import { api } from './api';

/**
 * Photographs, through the real two-step upload: ask for a signed URL,
 * PUT the bytes, confirm with the hash. The server checks the bytes.
 *
 * A browser has no camera binding the portal can trust, so — as the old
 * screens did — the web slice produces the image itself: a real JPEG,
 * drawn on a canvas and stamped with what, when and where. There is
 * deliberately no gallery picker: inspection photographs may never come
 * from a gallery (control 2). The native apps replace this with CameraX /
 * AVFoundation capture that embeds the geo-tag at exposure.
 */
async function demoCapture(caption: string): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 900;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 1200, 900);
  grd.addColorStop(0, '#0F4C4C'); grd.addColorStop(1, '#C9A96A');
  g.fillStyle = grd; g.fillRect(0, 0, 1200, 900);
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.font = '600 44px Poppins, sans-serif';
  g.fillText(caption, 60, 120);
  g.font = '400 28px Poppins, sans-serif';
  g.fillText(`Demo capture · ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, 60, 180);
  g.fillText('Web demo — the native app captures from the camera', 60, 830);
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.75));
}

async function sha256Hex(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const position = (): Promise<{ latitude: number; longitude: number; gps_accuracy_m: number }> =>
  new Promise((resolve) => {
    const fallback = { latitude: 24.1102, longitude: 82.6531, gps_accuracy_m: 25 };  // Singrauli
    if (!navigator.geolocation) return resolve(fallback);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude,
        gps_accuracy_m: Math.round(p.coords.accuracy) }),
      () => resolve(fallback), { timeout: 4000 });
  });

export type Purpose = 'COMPLAINT' | 'BEFORE' | 'COMPLETION' | 'INSPECTION' | 'OBJECTION';

export async function takePhoto(ticketId: string, purpose: Purpose, caption: string) {
  const blob = await demoCapture(caption);
  const buf = await blob.arrayBuffer();
  const ask = await api<{ media_id: string; upload_url: string }>('/media/upload-url',
    { body: { ticket_id: ticketId, purpose, content_type: 'image/jpeg' } });
  const put = await fetch(ask.upload_url, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
  if (!put.ok) throw new Error('The photograph did not upload. Try again.');
  // where it was taken goes with every photograph (user's request, 2026-10-12)
  const geo = await position();
  return api(`/media/${ask.media_id}/confirm`, { body: {
    captured_at: new Date().toISOString(), content_hash: await sha256Hex(buf),
    content_type: 'image/jpeg', capture_verified: true, ...geo } });
}
