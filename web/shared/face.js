// Face / fingerprint / screen-lock unlock using a platform passkey (WebAuthn).
//
// Two strengths, chosen automatically:
//  - "strong": the browser supports the PRF extension, so the encryption key is
//    produced by the passkey itself and exists only after a successful unlock.
//  - "basic": no PRF. The passkey still has to be approved to unlock, but the
//    key is a stored non-extractable browser key, so it acts as a screen lock
//    rather than being part of the encryption.
// Either way the user sees the same thing: approve with face or fingerprint.
import { newDeviceKey } from './crypto.js';
import { UserError, encoder, fromB64, randomBytes, toB64 } from './util.js';

const RECORD = 'face';

async function prfKey(prfBytes) {
  const material = await crypto.subtle.importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('tbd-face-v1'), info: encoder.encode(location.hostname) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function friendly(error) {
  if (error instanceof UserError) return error;
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return new UserError('Face unlock was cancelled or not recognised. Try again.');
  }
  if (error?.name === 'InvalidStateError') {
    return new UserError('Face lock is already set up here. Try unlocking instead.');
  }
  console.error(error);
  return new UserError('Face lock is not available. Turn on a screen lock (face, fingerprint or PIN) and try again.');
}

export class FaceLock {
  #store;
  #appName;

  constructor(store, appName) {
    this.#store = store;
    this.#appName = appName;
  }

  static async available() {
    try {
      return Boolean(
        window.PublicKeyCredential &&
          (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()),
      );
    } catch {
      return false;
    }
  }

  /** 'strong', 'basic', or null if face lock has not been set up. */
  async mode() {
    const record = await this.#store.get(RECORD);
    return record ? (record.mode === 'prf' ? 'strong' : 'basic') : null;
  }

  /** Creates the passkey and returns the key that protects this app's data. */
  async enroll() {
    try {
      const salt = randomBytes(32);
      const created = await navigator.credentials.create({
        publicKey: {
          rp: { name: this.#appName },
          user: { id: randomBytes(16), name: 'owner', displayName: 'Owner' },
          challenge: randomBytes(32),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          extensions: { prf: { eval: { first: salt } } },
          timeout: 60000,
          attestation: 'none',
        },
      });
      const credId = new Uint8Array(created.rawId);
      const extension = created.getClientExtensionResults?.().prf;
      let prf = extension?.results?.first ?? null;
      if (!prf && extension?.enabled) prf = await this.#evaluate(credId, salt);
      if (prf) {
        await this.#store.set(RECORD, { mode: 'prf', credId: toB64(credId), salt: toB64(salt) });
        return prfKey(prf);
      }
      const deviceKey = await newDeviceKey();
      await this.#store.set(RECORD, { mode: 'device', credId: toB64(credId), deviceKey });
      return deviceKey;
    } catch (error) {
      throw friendly(error);
    }
  }

  async #evaluate(credId, salt) {
    const result = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt } } },
        timeout: 60000,
      },
    });
    return result.getClientExtensionResults?.().prf?.results?.first ?? null;
  }

  /** Asks for face or fingerprint and returns the key. Throws UserError if refused. */
  async unlock() {
    try {
      const record = await this.#store.get(RECORD);
      if (!record) throw new UserError('Face lock is not set up on this device.');
      const credId = fromB64(record.credId);
      if (record.mode === 'prf') {
        const prf = await this.#evaluate(credId, fromB64(record.salt));
        if (!prf) throw new UserError('Face unlock did not complete. Try again.');
        return prfKey(prf);
      }
      await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: [{ type: 'public-key', id: credId }],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      return record.deviceKey;
    } catch (error) {
      throw friendly(error);
    }
  }
}
