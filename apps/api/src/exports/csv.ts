import type { Response } from 'express';

/** Excel opens a UTF-8 CSV as such only when it starts with this. */
export const BOM = '\uFEFF';

/** A spreadsheet runs a text cell starting with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (typeof value === 'string') text = value;
  else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    text = String(value);
  else text = JSON.stringify(value); // an object or array: its JSON
  // numbers are not text: a negative one stays as it is, a text like "-2+3" is defused
  if (typeof value === 'string' && FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV record (RFC 4180): quoted where needed, null and undefined empty, CRLF at the end. */
export function csvLine(values: unknown[]): string {
  return values.map(cell).join(',') + '\r\n';
}

/** Formats an instant as `YYYY-MM-DD HH:mm:ss` on the wall clock of `timeZone`. */
export function localDateTime(timeZone: string): (at: Date) => string {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (at) => {
    const p: Record<string, string> = {};
    for (const part of format.formatToParts(at)) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
}

/** Resolves on the next `drain`, or as soon as the response is gone or the signal aborts. */
function drained(res: Response, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Streams a CSV: the BOM and `header`, then each batch as one write. The next batch is only read
 * once the previous one has left for the socket (it waits for `drain`), so a slow client slows
 * the database reads and the server holds one batch, never the table. It stops, and closes
 * `batches` (which ends its database reads), when `signal` aborts or the response is gone.
 *
 * The first batch is read before anything is sent, so a failing query is still a normal JSON
 * error and `headers` (the file's content type and name) are not set on it. A failure after that
 * rejects with the response left open: the caller must cut the connection, so the file is never
 * mistaken for a complete one.
 */
export async function streamCsv(
  res: Response,
  header: string[],
  batches: AsyncIterable<unknown[][]>,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<void> {
  const iterator = batches[Symbol.asyncIterator]();
  const gone = () => signal.aborted || res.destroyed;
  try {
    let step = await iterator.next();
    if (gone()) return;

    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    if (!res.write(BOM + csvLine(header))) await drained(res, signal);

    while (!step.done) {
      if (gone()) return;
      if (!res.write(step.value.map(csvLine).join(''))) {
        await drained(res, signal);
      }
      if (gone()) return;
      step = await iterator.next();
    }
    res.end();
  } finally {
    await iterator.return?.();
  }
}
