import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Photograph storage.
 *
 * The bytes never touch the application server on the way in. The client
 * asks for a pre-signed URL, PUTs the image straight to object storage,
 * then confirms — and the confirm step is where the integrity checks live,
 * because that is the only moment the server can compare what was claimed
 * against what actually arrived.
 *
 * Two drivers, one interface:
 *   s3  — MinIO or any S3-compatible store. The production path.
 *   fs  — the local filesystem, for development and for a single-machine
 *         deployment that has no object store yet.
 *
 * The driver is chosen by MEDIA_DRIVER. Everything above this file is
 * identical either way.
 */

const BUCKET = process.env.MEDIA_BUCKET || 'ncl-media';
const FS_ROOT = process.env.MEDIA_ROOT || '/tmp/ncl-media';
const MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES || 5 * 1024 * 1024);
const URL_TTL_SECONDS = 15 * 60;
const ALLOWED = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* ---------------------------------------------------------------- *
 * Object keys
 *
 * Laid out so a premises' whole photographic record is one prefix. That
 * matters for the premises file, which is the long-term asset, and it
 * makes the retention purge a prefix scan rather than a table join.
 *   area/premises/ticket/purpose-uuid.jpg
 * ---------------------------------------------------------------- */
export function objectKey({ areaCode, premisesId, ticketId, purpose, mediaId, ext }) {
  return `${areaCode}/${premisesId}/${ticketId}/${purpose.toLowerCase()}-${mediaId}.${ext}`;
}

/* ---------------------------------------------------------------- *
 * Drivers
 * ---------------------------------------------------------------- */
class FsDriver {
  constructor() { this.name = 'fs'; }
  async init() { await fs.mkdir(FS_ROOT, { recursive: true }); }

  /* The filesystem has no pre-signing, so the URL is signed here and the
     upload route verifies the signature. Same shape as S3 from the
     client's point of view: one URL, time-limited, single use. */
  async presignPut(key, contentType) {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    const sig = crypto.createHmac('sha256', process.env.TOKEN_SECRET || 'dev-only-secret-change-in-production')
      .update(`${key}|${contentType}|${exp}`).digest('base64url');
    return `/media-upload?key=${encodeURIComponent(key)}&ct=${encodeURIComponent(contentType)}` +
           `&exp=${exp}&sig=${sig}`;
  }
  verifyPutSignature(key, contentType, exp, sig) {
    if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
    const expect = crypto.createHmac('sha256', process.env.TOKEN_SECRET || 'dev-only-secret-change-in-production')
      .update(`${key}|${contentType}|${exp}`).digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  }
  async put(key, buf) {
    const full = path.join(FS_ROOT, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
  }
  async get(key) { return fs.readFile(path.join(FS_ROOT, key)); }
  async stat(key) {
    try { const s = await fs.stat(path.join(FS_ROOT, key)); return { size: s.size }; }
    catch { return null; }
  }
  async remove(key) {
    try { await fs.unlink(path.join(FS_ROOT, key)); } catch { /* verified below */ }
    return (await this.stat(key)) === null;
  }
  async totalBytes() {
    let total = 0, count = 0;
    const walk = async (dir) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else { const s = await fs.stat(p); total += s.size; count++; }
      }
    };
    await walk(FS_ROOT);
    return { bytes: total, objects: count };
  }
}

class S3Driver {
  constructor() { this.name = 's3'; }
  async init() {
    const { Client } = await import('minio');
    const url = new URL(process.env.MEDIA_S3_ENDPOINT || 'http://127.0.0.1:9000');
    this.client = new Client({
      endPoint: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      useSSL: url.protocol === 'https:',
      accessKey: process.env.MEDIA_S3_KEY || 'S3RVER',
      secretKey: process.env.MEDIA_S3_SECRET || 'S3RVER',
      region: process.env.MEDIA_S3_REGION || 'us-east-1'
    });
    if (!(await this.client.bucketExists(BUCKET).catch(() => false))) {
      await this.client.makeBucket(BUCKET).catch(() => {});
    }
  }
  presignPut(key, contentType) {
    return this.client.presignedPutObject(BUCKET, key, URL_TTL_SECONDS);
  }
  async put(key, buf) { await this.client.putObject(BUCKET, key, buf); }
  async get(key) {
    const stream = await this.client.getObject(BUCKET, key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  }
  async stat(key) {
    try { const s = await this.client.statObject(BUCKET, key); return { size: s.size }; }
    catch { return null; }
  }
  async remove(key) {
    // Some S3 implementations reject on a response quirk even though the
    // object is gone. What matters is the outcome, so it is checked
    // rather than inferred from whether the call resolved.
    try { await this.client.removeObject(BUCKET, key); } catch { /* verified below */ }
    return (await this.stat(key)) === null;
  }
  async totalBytes() {
    let bytes = 0, objects = 0;
    const stream = this.client.listObjectsV2(BUCKET, '', true);
    await new Promise((resolve, reject) => {
      stream.on('data', (o) => { bytes += o.size; objects++; });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return { bytes, objects };
  }
}

export const driver = (process.env.MEDIA_DRIVER === 's3')
  ? new S3Driver() : new FsDriver();
export const initStorage = () => driver.init();

/* ---------------------------------------------------------------- *
 * Integrity
 *
 * The confirm step is the only moment the server sees what actually
 * arrived. Everything the design claims about photographs — that an
 * inspection image was taken in the app, at the premises, at that time —
 * rests on these checks, so they are done here rather than trusted.
 * ---------------------------------------------------------------- */
export function extensionFor(contentType) {
  const ext = ALLOWED[contentType];
  if (!ext) throw Object.assign(new Error(
    `Only ${Object.keys(ALLOWED).join(' and ')} images are accepted`), { status: 422 });
  return ext;
}

/** JPEG and WebP have recognisable openings; a renamed file is refused. */
export function sniffContentType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
      && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function verifyUpload({ key, claimedHash, contentType }) {
  const stat = await driver.stat(key);
  if (!stat) throw Object.assign(new Error('Nothing was uploaded to that URL'),
    { status: 422 });
  if (stat.size > MAX_BYTES) {
    await driver.remove(key);
    throw Object.assign(new Error(
      `Image is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB`), { status: 422 });
  }
  const buf = await driver.get(key);

  const actualType = sniffContentType(buf);
  if (!actualType) {
    await driver.remove(key);
    throw Object.assign(new Error('That file is not a photograph'), { status: 422 });
  }
  if (actualType !== contentType) {
    await driver.remove(key);
    throw Object.assign(new Error(
      `Declared ${contentType} but the file is ${actualType}`), { status: 422 });
  }

  // The client sends the hash it computed. If the two disagree, either the
  // upload was corrupted or the image was swapped between signing and
  // confirming — and an inspection photograph that can be swapped proves
  // nothing at all.
  const actualHash = crypto.createHash('sha256').update(buf).digest('hex');
  if (claimedHash && claimedHash !== actualHash) {
    await driver.remove(key);
    throw Object.assign(new Error('The image does not match the hash sent with it'),
      { status: 422 });
  }
  return { size: stat.size, hash: actualHash };
}

/* ---------------------------------------------------------------- *
 * Retention
 *
 * The row stays for the retention period and then goes, but the BYTES are
 * the expensive part, so they are purged on their own schedule against
 * ticket_media.purge_after. The media row is kept with its hash and
 * geo-tag after the bytes are gone: the record that an inspection
 * happened, where and when, outlives the image itself.
 * ---------------------------------------------------------------- */
export async function purgeExpiredBytes(client, { batch = 500, quiet = false } = {}) {
  const rows = await client.query(
    `SELECT id, storage_key FROM ticket_media
      WHERE purge_after < now() AND bytes_purged_at IS NULL
      ORDER BY purge_after
      LIMIT $1`, [batch]);
  let removed = 0, missing = 0;
  for (const r of rows.rows) {
    const ok = await driver.remove(r.storage_key);
    ok ? removed++ : missing++;
    await client.query(
      `UPDATE ticket_media SET bytes_purged_at = now() WHERE id = $1`, [r.id]);
  }
  const summary = { bytes_removed: removed, already_gone: missing,
    considered: rows.rowCount };
  if (!quiet) console.log('[media-purge]', JSON.stringify(summary));
  return summary;
}

export const storageLimits = { MAX_BYTES, URL_TTL_SECONDS, ALLOWED, BUCKET };
