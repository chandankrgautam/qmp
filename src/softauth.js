/**
 * A software passkey, for the tests only: it answers the server's WebAuthn
 * challenges the way a phone or security key would (ES256, "none"
 * attestation, user present and verified), so the suites can register and
 * sign in through the real verification. Never used by the portal itself.
 *
 *   const a = new SoftAuthenticator({ origin, rpId });
 *   const reg = a.register(registrationOptions);        // → RegistrationResponseJSON
 *   const asr = a.authenticate(authenticationOptions);  // → AuthenticationResponseJSON
 *
 * Options let a test misbehave on purpose: { uv: false } (no fingerprint or
 * PIN), { counter } (a cloned key going backwards), { origin } (a lookalike
 * site), { credentialId } (choose which stored key answers).
 */
import crypto from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

export class SoftAuthenticator {
  constructor({ origin = 'http://localhost:5173', rpId = 'localhost' } = {}) {
    this.origin = origin; this.rpId = rpId;
    this.keys = new Map();   // credential id (base64url) → { privateKey, userHandle, counter }
  }

  register(options, { uv = true, origin } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = crypto.randomBytes(32);
    const cose = new Map([[1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]);
    const coseBytes = Buffer.from(isoCBOR.encode(cose));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const flags = 0x01 | (uv ? 0x04 : 0) | 0x40;   // user present, verified, attested data
    const authData = Buffer.concat([sha256(Buffer.from(options.rp?.id || this.rpId)), Buffer.from([flags]), u32(0),
      Buffer.alloc(16), idLen, credId, coseBytes]);
    const attObj = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]])));
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge,
      origin: origin || this.origin, crossOrigin: false }));
    const id = b64u(credId);
    this.keys.set(id, { privateKey, userHandle: options.user?.id, counter: 0 });
    return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj), transports: ['internal'] } };
  }

  authenticate(options, { uv = true, origin, counter, credentialId } = {}) {
    const allowed = (options.allowCredentials || []).map((c) => c.id);
    const id = credentialId || (allowed.length ? allowed.find((x) => this.keys.has(x)) : [...this.keys.keys()][0]);
    const k = this.keys.get(id);
    if (!k) throw new Error('this authenticator holds no key for that site');
    k.counter = counter ?? k.counter + 1;
    const flags = 0x01 | (uv ? 0x04 : 0);
    const authData = Buffer.concat([sha256(Buffer.from(options.rpId || this.rpId)), Buffer.from([flags]), u32(k.counter)]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge,
      origin: origin || this.origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), k.privateKey);
    return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature),
        userHandle: k.userHandle } };
  }
}
