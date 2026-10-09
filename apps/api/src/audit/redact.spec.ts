import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('replaces secret keys at any depth, including inside arrays', () => {
    const input = {
      name: 'x',
      password: 'p',
      nested: {
        passwordHash: 'h',
        keep: 1,
        deeper: [{ token: 't', ok: true }],
      },
      list: [{ mainStreamUrl: 'rtsp://u:p@h/1' }, 'plain'],
      currentPassword: 'a',
      newPassword: 'b',
      tokenHash: 'th',
      subStreamUrl: 's',
      mainStreamUrlEnc: 'e',
      subStreamUrlEnc: 'e2',
    };
    expect(redactSecrets(input)).toEqual({
      name: 'x',
      password: '[redacted]',
      nested: {
        passwordHash: '[redacted]',
        keep: 1,
        deeper: [{ token: '[redacted]', ok: true }],
      },
      list: [{ mainStreamUrl: '[redacted]' }, 'plain'],
      currentPassword: '[redacted]',
      newPassword: '[redacted]',
      tokenHash: '[redacted]',
      subStreamUrl: '[redacted]',
      mainStreamUrlEnc: '[redacted]',
      subStreamUrlEnc: '[redacted]',
    });
  });

  it('does not modify its input', () => {
    const input = { a: { password: 'p' }, b: [{ token: 't' }] };
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    const out = redactSecrets(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
  });

  it('passes primitives and null through', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(5)).toBe(5);
    expect(redactSecrets('s')).toBe('s');
  });
});
