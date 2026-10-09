import { randomBytes } from 'node:crypto';
import { UrlCipher } from './url-cipher';

const URL_PLAIN = 'rtsp://admin:s3cret@10.0.0.5:554/stream1';

describe('UrlCipher', () => {
  const cipher = new UrlCipher(randomBytes(32));

  it('round-trips', () => {
    expect(cipher.decrypt(cipher.encrypt(URL_PLAIN))).toBe(URL_PLAIN);
  });

  it('uses the v1.<iv>.<tag>.<ciphertext> format without the plaintext', () => {
    const stored = cipher.encrypt(URL_PLAIN);
    const parts = stored.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16);
    expect(stored).not.toContain('s3cret');
  });

  it('two encryptions of the same URL differ', () => {
    expect(cipher.encrypt(URL_PLAIN)).not.toBe(cipher.encrypt(URL_PLAIN));
  });

  it('throws when one ciphertext byte is flipped', () => {
    const [v, iv, tag, ct] = cipher.encrypt(URL_PLAIN).split('.');
    const bytes = Buffer.from(ct, 'base64url');
    bytes[0] ^= 0x01;
    const tampered = [v, iv, tag, bytes.toString('base64url')].join('.');
    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  it('throws when the tag is changed, the key differs, or the format is wrong', () => {
    const [v, iv, tag, ct] = cipher.encrypt(URL_PLAIN).split('.');
    const badTag = Buffer.from(tag, 'base64url');
    badTag[0] ^= 0x01;
    expect(() =>
      cipher.decrypt([v, iv, badTag.toString('base64url'), ct].join('.')),
    ).toThrow();
    expect(() =>
      new UrlCipher(randomBytes(32)).decrypt(cipher.encrypt(URL_PLAIN)),
    ).toThrow();
    expect(() => cipher.decrypt('garbage')).toThrow();
  });

  it('a 16-byte key makes the constructor throw', () => {
    expect(() => new UrlCipher(randomBytes(16))).toThrow();
  });
});
