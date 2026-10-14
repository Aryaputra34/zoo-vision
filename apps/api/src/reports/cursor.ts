import { apiError } from '../common/errors';

/** Where a page ended: the sort time (ISO, milliseconds, UTC) and the row id that breaks ties. */
export type Cursor = { t: string; id: string };

/** The opaque `nextCursor` string of a page. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, id: c.id })).toString(
    'base64url',
  );
}

/** Reads a cursor a client sent back; 400 VALIDATION_FAILED for anything this server did not make. */
export function decodeCursor(s: string): Cursor {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(s, 'base64url').toString('utf8'),
    );
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { t, id } = value as Record<string, unknown>;
      if (
        typeof t === 'string' &&
        typeof id === 'string' &&
        id !== '' &&
        // only the canonical form encodeCursor wrote, so a date like "2026-10-14" is refused
        new Date(t).toISOString() === t
      ) {
        return { t, id };
      }
    }
  } catch {
    // falls through to the error
  }
  throw apiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
    { path: '/cursor', message: 'is not a cursor this API issued' },
  ]);
}
