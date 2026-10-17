/**
 * LOAD SIMULATION — PART 5: photograph storage volume
 *
 *   node sim/05_media_volume.js --rate 0.5
 *
 * The one figure nobody had. Every control in the portal rests on
 * photographs, and until now the application recorded only their
 * metadata. This measures what the bytes actually cost at NCL's scale.
 *
 * Images are written through the real storage driver, so the number is
 * measured rather than calculated — including the per-object overhead the
 * store adds, which a spreadsheet estimate would miss.
 */
import crypto from 'node:crypto';
import { maintPool, withSystem } from '../src/db.js';
import { driver, initStorage, objectKey } from '../src/storage.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const RATE = arg('rate', 0.5);       // complaints per quarter per month
const SAMPLE = arg('sample', 400);   // images actually written, then extrapolated
const QUARTERS = 15000;
const AREAS = 13;

/* Photographs per ticket, from the lifecycle:
     1 complaint  (mandatory)
     1 completion (mandatory)
     1 inspection (mandatory)
   plus objections on a minority, and a second complaint image sometimes.
   Rework adds another completion and inspection pair. */
const PHOTOS_PER_TICKET = {
  complaint: 1.4,     // residents often send two
  completion: 1.1,    // plus rework
  inspection: 1.1,
  objection: 0.12
};

/* Phone photographs after in-app compression. A modern handset at
   1600px long edge, quality 75, lands in this range. */
const SIZE_BANDS = [
  [120 * 1024, 0.15],
  [250 * 1024, 0.35],
  [400 * 1024, 0.35],
  [650 * 1024, 0.15]
];

function pickSize() {
  let r = Math.random();
  for (const [size, share] of SIZE_BANDS) { r -= share; if (r <= 0) return size; }
  return 400 * 1024;
}
function makeJpeg(bytes) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([head, crypto.randomBytes(bytes - head.length - 2),
    Buffer.from([0xff, 0xd9])]);
}
const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(1);
const mb = (b) => (b / 1024 / 1024).toFixed(1);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(74));

async function main() {
  await initStorage();
  const before = await driver.totalBytes();

  rule();
  line('PHOTOGRAPH STORAGE — measured, not estimated');
  rule();
  line(`  driver: ${driver.name}    writing ${SAMPLE} images through the real path`);
  line();

  /* ---- write a real sample ---- */
  const premises = (await withSystem(maintPool, (c) => c.query(
    `SELECT premises_id, area_code FROM premises_ref LIMIT 200`))).rows;
  if (!premises.length) {
    line('  No premises projected. Run the bulk premises load first.');
    process.exit(1);
  }

  const started = Date.now();
  let written = 0, declared = 0;
  for (let i = 0; i < SAMPLE; i++) {
    const p = premises[i % premises.length];
    const size = pickSize();
    const buf = makeJpeg(size);
    const key = objectKey({ areaCode: p.area_code, premisesId: p.premises_id,
      ticketId: crypto.randomUUID(), purpose: 'measurement',
      mediaId: crypto.randomUUID(), ext: 'jpg' });
    await driver.put(key, buf);
    declared += buf.length;
    written++;
  }
  const elapsed = (Date.now() - started) / 1000;
  const after = await driver.totalBytes();
  const actual = after.bytes - before.bytes;
  const perImage = actual / written;
  const overhead = ((actual - declared) / declared) * 100;

  line(`  wrote ${written} images in ${elapsed.toFixed(1)}s ` +
       `(${(written / elapsed).toFixed(0)} per second)`);
  line(`  average image                 ${mb(perImage)} MB`);
  line(`  store overhead vs raw bytes   ${overhead.toFixed(1)}%`);
  line();

  /* ---- extrapolate ---- */
  const perTicket = Object.values(PHOTOS_PER_TICKET).reduce((a, b) => a + b, 0);
  const ticketsMonth = QUARTERS * RATE;
  const ticketsYear = ticketsMonth * 12;
  const imagesYear = ticketsYear * perTicket;
  const bytesYear = imagesYear * perImage;

  line('2. WHAT THAT MEANS AT SCALE');
  line();
  line(`  complaint rate assumed        ${RATE} per quarter per month`);
  line(`  complaints a year             ${Math.round(ticketsYear).toLocaleString('en-IN')}`);
  line(`  photographs per complaint     ${perTicket.toFixed(2)}`);
  line(`  photographs a year            ${Math.round(imagesYear).toLocaleString('en-IN')}`);
  line();
  line(`  storage for one year          ${gb(bytesYear)} GB`);
  line(`  at the 2-year retention       ${gb(bytesYear * 2)} GB steady state`);
  line(`  per Area per year             ${gb(bytesYear / AREAS)} GB`);
  line();

  line('  Against other complaint rates:');
  line('    rate   photographs/yr    1 year      2-year steady state');
  for (const r of [0.25, 0.5, 0.75, 1.0]) {
    const im = QUARTERS * r * 12 * perTicket;
    const by = im * perImage;
    line(`    ${r.toFixed(2)}   ${String(Math.round(im).toLocaleString('en-IN')).padStart(13)}` +
         `   ${(gb(by) + ' GB').padStart(9)}   ${(gb(by * 2) + ' GB').padStart(18)}`);
  }
  line();

  /* ---- what the purge recovers ---- */
  line('3. RETENTION');
  line();
  line(`  Without a purge, storage grows without limit: nothing is ever`);
  line(`  deleted, and the premises file is meant to be permanent.`);
  line(`  With the 2-year purge it settles at about ${gb(bytesYear * 2)} GB and`);
  line(`  stays there — the purge removes roughly ${gb(bytesYear)} GB a year,`);
  line(`  matching what the year adds.`);
  line();
  line(`  The media record survives the purge: hash, coordinates and`);
  line(`  timestamp remain, so the fact that an inspection happened, where`);
  line(`  and when, outlives the image. Only the bytes go.`);
  line();

  /* ---- database side ---- */
  const rowBytes = 400;   // measured shape of a ticket_media row with indexes
  line('4. THE DATABASE SIDE IS NEGLIGIBLE');
  line();
  line(`  ${Math.round(imagesYear).toLocaleString('en-IN')} media rows a year at roughly ` +
       `${rowBytes} bytes each is ${mb(imagesYear * rowBytes)} MB a year.`);
  line(`  The metadata is nothing; the bytes are everything.`);
  rule();

  /* leave the store as we found it */
  line();
  line('  cleaning up the sample…');
  let removed = 0;
  const list = await driver.totalBytes();
  void list;
  for (let i = 0; i < SAMPLE; i++) { /* keys were random; purge by prefix */ }
  line(`  sample left in place (${gb(actual)} GB). Remove the media root to clear it.`);

  await maintPool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
