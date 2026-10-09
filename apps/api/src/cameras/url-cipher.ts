import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for the stored camera stream URLs. A fresh random 12-byte IV per encryption;
 * stored as `v1.<iv>.<tag>.<ciphertext>` (base64url parts). Errors never carry the plaintext.
 */
export class UrlCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('UrlCipher needs a 32-byte key');
    }
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Throws when the value is malformed, tampered with, or encrypted under another key. */
  decrypt(stored: string): string {
    const parts = stored.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Unsupported stored URL format');
    }
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('Unsupported stored URL format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
