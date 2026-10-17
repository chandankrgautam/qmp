import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// API_PORT, not PORT: the preview runner sets PORT for this dev server itself
const API = `http://127.0.0.1:${process.env.API_PORT || 3000}`;
// DEVICES_FILE lets a second dev server sign in to the test databases' keys
const DEVICES = path.resolve(import.meta.dirname, '..', process.env.DEVICES_FILE || 'devices.json');

/**
 * DEVELOPMENT ONLY — signs in as a seeded device.
 *
 * On a handset the private key lives in the Keystore / Secure Enclave and
 * signs the server's challenge itself. A browser has neither, so for the
 * demo the dev server holds the seeded keys (devices.json, written by
 * `npm run seed`) and signs on the device's behalf — exactly what the old
 * server-rendered screens did. The challenge/signature exchange with the
 * real API is unchanged. This plugin exists only in `vite dev`; a
 * production build contains none of it, and it must never be deployed.
 */
function demoDevices(): Plugin {
  const read = () => (fs.existsSync(DEVICES) ? JSON.parse(fs.readFileSync(DEVICES, 'utf8')) : {});
  const body = (req: any): Promise<any> => new Promise((resolve) => {
    let s = ''; req.on('data', (c: any) => (s += c)); req.on('end', () => resolve(s ? JSON.parse(s) : {}));
  });
  const json = (res: any, status: number, obj: unknown) => {
    res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj));
  };
  const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(API + p, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };

  // a failure here must answer the browser, never take the dev server down
  const safe = (fn: (req: any, res: any) => Promise<void>) => (req: any, res: any) =>
    fn(req, res).catch((e) => json(res, 502, { detail: `The API server is not reachable (${e.cause?.code || e.message}). Start it with npm start.` }));

  return {
    name: 'demo-devices',
    apply: 'serve',
    configureServer(server) {
      // One entry per phone (a person's keys all share one device), with the
      // roles that phone's person holds — the sign-in screen groups by it.
      server.middlewares.use('/demo/devices', (_req, res) => {
        const byDevice: Record<string, any> = {};
        for (const [key, v] of Object.entries<any>(read())) {
          const id = v.device_id || key;
          byDevice[id] ||= { key, name: v.name, person_id: v.person_id, employee_id: v.employee_id, roles: [] };
          byDevice[id].roles.push(v.role);
        }
        json(res, 200, Object.values(byDevice));
      });
      // Sign in with this phone's key. With no role named, a person who
      // holds several roles gets the role list back (person_token).
      server.middlewares.use('/demo/login', safe(async (req, res) => {
        const { key, role, assignment_id } = await body(req);
        const d = read()[key];
        if (!d) return json(res, 404, { detail: 'No such device on this machine' });
        const ch = await post('/identity/v1/auth/challenge', { public_key: d.publicKey });
        if (!ch.body.nonce) return json(res, 403, { detail: ch.body.error || 'Device not registered' });
        const sig = crypto.sign('sha256', Buffer.from(ch.body.nonce),
          { key: d.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
        // second factor: the demo asserts the PIN/biometric unlock a handset would do
        const tok = await post('/identity/v1/auth/token', { public_key: d.publicKey,
          nonce: ch.body.nonce, signature: sig, second_factor_satisfied: true, role, assignment_id });
        const ok = tok.body.token || tok.body.person_token;
        // the name shown is the person's on record; an older entry labelled
        // with a typed name is corrected here, for the list too
        let name = d.name;
        if (tok.body.token) {
          const me = await fetch(`${API}/identity/v1/me`, { headers: { authorization: `Bearer ${tok.body.token}` } }).then((x) => x.json() as Promise<any>).catch(() => ({} as any));
          if (me.person_name && me.person_name !== d.name) {
            name = me.person_name;
            const all = read();
            for (const v of Object.values<any>(all)) if ((v.device_id || '') === (d.device_id || '-')) v.name = name;
            fs.writeFileSync(DEVICES, JSON.stringify(all, null, 2));
          }
        }
        json(res, ok ? 200 : 403, ok ? { ...tok.body, name } : { detail: tok.body.error || 'Sign-in refused' });
      }));
      // registration: the "handset" makes its keypair here and keeps it, as ui.js did
      server.middlewares.use('/demo/register', safe(async (req, res) => {
        const { fields, registration_token } = await body(req);
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
          namedCurve: 'prime256v1', publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
        const r = await post('/identity/v1/registrations', { ...fields, public_key: publicKey },
          { 'x-registration-token': registration_token });
        if (r.status !== 201) return json(res, r.status, r.body);
        // the phone belongs to whoever owns the proved mobile — label it with
        // that person's name, not the one typed (user's finding, 2026-10-12)
        const owner = r.body.name || fields.name;
        const all = read();
        all[`${fields.role || 'DEVICE'}:${owner} (pending)`] = { device_id: r.body.id, publicKey, privateKey,
          role: fields.role || 'DEVICE', name: owner, scope: '' };
        fs.writeFileSync(DEVICES, JSON.stringify(all, null, 2));
        json(res, 201, r.body);
      }));
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), demoDevices()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/maintenance/v1': API,
      '/identity/v1': API,
      '/media-upload': API
    }
  }
});
