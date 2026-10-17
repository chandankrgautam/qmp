import express from 'express';
import { api, publicMaint } from './maintenance.js';
import { issueChallenge, exchangeSignature, refreshAccess, passwordSignIn, setPasswordWithOtp, selectRole, contractorSignIn } from './auth.js';
import { identityApi, publicApi } from './identity.js';
import { startScheduler } from './notify.js';
import { runArchiveSweep } from './archive.js';
import { contracts, runContractSweep } from './contracts.js';
import { jobcards } from './jobcards.js';
import { materials } from './materials.js';
import { reviews } from './reviews.js';
import { notices } from './notices.js';
import { sheets } from './sheets.js';
import { mb } from './mb.js';
import { hq } from './hq.js';
import { passkeys } from './passkeys.js';
import { driver, initStorage } from './storage.js';
import { maintPool, withSystem } from './db.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/identity/v1/auth/challenge', async (req, res) => {
  const r = await issueChallenge(req.body.public_key);
  res.status(r.error ? 404 : 200).json(r);
});
app.post('/identity/v1/auth/refresh', async (req, res) => {
  const r = await refreshAccess(req.body?.refresh_token);
  res.status(r.error ? 401 : 200).json(r);
});
app.post('/identity/v1/auth/token', async (req, res) => {
  const r = await exchangeSignature(req.body);
  res.status(r.error ? 403 : 200).json(r);
});
/* Employee ID + password (web). OTP is used only to set or reset it. */
app.post('/identity/v1/auth/password', async (req, res) => {
  const r = await passwordSignIn(req.body || {});
  res.status(r.error ? 401 : 200).json(r);
});
app.post('/identity/v1/auth/password/set', async (req, res) => {
  const r = await setPasswordWithOtp(req.body || {});
  res.status(r.error ? (r.status || 422) : 200).json(r.error ? { title: 'Error', status: r.status || 422, detail: r.error } : r);
});
/* Contractor staff on the web: the mobile proved by OTP, every time (2026-10-16). */
app.post('/identity/v1/auth/contractor', async (req, res) => {
  const r = await contractorSignIn(req.body || {});
  res.status(r.error ? (r.status || 401) : 200).json(r);
});
/* A person holding several roles picks the one to act in. */
app.post('/identity/v1/auth/select-role', async (req, res) => {
  const r = await selectRole(req.body || {});
  res.status(r.error ? 403 : 200).json(r);
});

/* The filesystem driver's equivalent of a pre-signed S3 PUT. The
   signature carries the key, content type and expiry, so a client cannot
   write anywhere it was not invited to. With MEDIA_DRIVER=s3 this route
   is never used: the client PUTs straight to object storage. */
app.put('/media-upload', express.raw({ type: '*/*', limit: '8mb' }),
  async (req, res) => {
    const { key, ct, exp, sig } = req.query;
    if (!driver.verifyPutSignature || !driver.verifyPutSignature(key, ct, exp, sig)) {
      return res.status(403).json({ title: 'Upload link is not valid', status: 403 });
    }
    // An upload link is good for one photograph, once. After the upload is
    // confirmed its bytes are evidence: a second PUT to the same link would
    // swap the picture under a recorded fingerprint (break-it pass, 2026-10-08).
    const done = await withSystem(maintPool, (c) => c.query(
      `SELECT 1 FROM ticket_media WHERE storage_key = $1 AND upload_state = 'STORED'`, [key]));
    if (done.rowCount) {
      return res.status(409).json({ title: 'Already uploaded', status: 409,
        detail: 'This photograph is already stored and cannot be replaced.' });
    }
    await driver.put(key, req.body);
    res.status(200).end();
  });

app.use('/identity/v1', publicApi);
app.use('/identity/v1', passkeys);
app.use('/identity/v1', identityApi);
app.use('/maintenance/v1', publicMaint);
app.use('/maintenance/v1', contracts);
app.use('/maintenance/v1', jobcards);
app.use('/maintenance/v1', materials);
app.use('/maintenance/v1', reviews);
app.use('/maintenance/v1', notices);
app.use('/maintenance/v1', sheets);
app.use('/maintenance/v1', mb);
app.use('/maintenance/v1', hq);
app.use('/maintenance/v1', api);
// The server-rendered demo screens were retired on 2026-09-30; the web
// portal (web/) replaces them.
app.get('/', (req, res) => res.json({ service: 'NCL Colony Maintenance Portal API',
  portal: 'run `npm run web` for the web portal' }));

const port = process.env.PORT || 3000;
/* A process that exits without saying why is an operational problem in
   its own right: during a trial nobody would know the portal had stopped,
   let alone what stopped it. */
process.on('unhandledRejection', (e) => {
  console.error('[unhandled rejection]', e?.stack || e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaught exception]', e?.stack || e);
});

await initStorage();
app.listen(port, '0.0.0.0', () => {
  console.log(`listening on ${port}`);
  // The SLA sweep must run somewhere. One minute here so behaviour is
  // observable; production would use a scheduler outside the web process.
  if (process.env.NO_SCHEDULER !== '1') {
    startScheduler(60_000);
    // Archiving is slow-moving; nightly is ample. Hourly here so the
    // behaviour is observable during trials.
    const archive = () => runArchiveSweep({ quiet: true })
      .catch((e) => console.error('[archive-sweep] failed', e.message));
    archive();
    setInterval(archive, 3_600_000);
    // Contract expiry moves by the day, so daily is ample; hourly here so
    // the behaviour is observable during trials.
    const sweep = () => runContractSweep({ quiet: true })
      .catch((e) => console.error('[contract-sweep] failed', e.message));
    sweep();
    setInterval(sweep, 3_600_000);
  }
});
