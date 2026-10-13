const SECRET_KEYS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'mainStreamUrl',
  'subStreamUrl',
  'mainStreamUrlEnc',
  'subStreamUrlEnc',
]);

/**
 * Deep copy of `value` with every secret-named key (at any depth, also inside arrays) set to
 * "[redacted]". The safety net under audit rows; DTOs should not carry secrets in the first place.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value instanceof Date) return new Date(value.getTime());
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEYS.has(key) ? '[redacted]' : redactSecrets(v);
    }
    return out;
  }
  return value;
}
