import crypto from 'node:crypto';

/**
 * The two-step photograph upload, as a client performs it.
 *
 * Shared by the test suites so that a change to the upload contract shows
 * up in one place rather than six. This deliberately goes through the real
 * flow — pre-signed URL, PUT the bytes, confirm — rather than short-cutting
 * to a metadata row, because the byte checks at confirm are the control
 * the inspection gate rests on.
 */

/* A genuine, if minimal, JPEG. Real enough that the server's own sniffing
   accepts it, at a size a phone photograph would plausibly be. */
export function makeJpeg(sizeBytes = 320 * 1024) {
  const head = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00
  ]);
  const body = crypto.randomBytes(Math.max(0, sizeBytes - head.length - 2));
  return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * @returns {Promise<{ok: boolean, status: number, media_id?: string, body: object}>}
 */
export async function uploadPhoto(base, token, ticketId, purpose, opts = {}) {
  const buf = opts.buffer || makeJpeg(opts.size);
  const contentType = opts.content_type || 'image/jpeg';

  const askRes = await fetch(`${base}/maintenance/v1/media/upload-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ticket_id: ticketId, purpose, content_type: contentType })
  });
  const ask = await askRes.json().catch(() => ({}));
  if (!ask.media_id) return { ok: false, status: askRes.status, body: ask };

  const url = ask.upload_url.startsWith('http') ? ask.upload_url : base + ask.upload_url;
  await fetch(url, { method: 'PUT', body: buf, headers: { 'content-type': contentType } });

  const confirmRes = await fetch(`${base}/maintenance/v1/media/${ask.media_id}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      captured_at: new Date().toISOString(),
      content_hash: sha256(buf),
      content_type: contentType,
      capture_verified: opts.capture_verified ?? true,
      // every photograph records where it was taken (user's decision,
      // 2026-10-12), as the app always does; latitude: null sends none
      latitude: opts.latitude === undefined ? 24.1102 : opts.latitude ?? undefined,
      longitude: opts.longitude === undefined ? 82.6531 : opts.longitude ?? undefined,
      gps_accuracy_m: opts.latitude === null ? undefined : (opts.gps_accuracy_m ?? 6.0)
    })
  });
  return { ok: confirmRes.ok, status: confirmRes.status, media_id: ask.media_id,
    body: await confirmRes.json().catch(() => ({})) };
}

/** An inspection photograph: in-app capture, at the premises. */
export const uploadInspection = (base, token, ticketId, opts = {}) =>
  uploadPhoto(base, token, ticketId, 'INSPECTION', {
    capture_verified: true, latitude: 24.1102, longitude: 82.6531, ...opts });

/** What a completion claim needs since 2026-10-07: one "before" and one
    "after" photograph of this round (located, as every photograph is
    since 2026-10-12). Returns the "after" upload's result. */
export async function uploadCompletion(base, token, ticketId, opts = {}) {
  await uploadPhoto(base, token, ticketId, 'BEFORE', opts);
  return uploadPhoto(base, token, ticketId, 'COMPLETION', opts);
}

/**
 * Photographs are optional until the HQ System Administrator requires them
 * (user's decision, 2026-10-12). Suites that test the photograph gate itself
 * switch both requirements on for their own scratch database first, so the
 * gate they test is the one that will be in force once HQ switches it on.
 */
export async function requirePhotos() {
  const { withSystem, maintPool } = await import('./db.js');
  await withSystem(maintPool, (c) => c.query(
    `UPDATE maint_config SET value = 'true' WHERE key IN ('completion_photos_required', 'inspection_photo_required')`));
}
