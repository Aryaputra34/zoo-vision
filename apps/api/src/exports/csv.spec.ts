import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { BOM, csvLine, localDateTime, streamCsv } from './csv';

describe('csvLine', () => {
  it('quotes a comma, a quote and a newline; leaves plain values bare', () => {
    expect(
      csvLine(['plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\rhere']),
    ).toBe('plain,"a,b","say ""hi""","two\nlines","cr\rhere"\r\n');
  });

  it('ends in CRLF; null, undefined and false-y numbers are written as they are', () => {
    expect(csvLine(['a', null, undefined, 0, false, 1.5, true])).toBe(
      'a,,,0,false,1.5,true\r\n',
    );
    expect(csvLine([])).toBe('\r\n');
  });

  it('defuses a text a spreadsheet would run as a formula, but not a number', () => {
    expect(csvLine(['=1+1', '+49', '-2+3', '@SUM(A1)', '\tx', '\rx'])).toBe(
      "'=1+1,'+49,'-2+3,'@SUM(A1),'\tx,\"'\rx\"\r\n",
    );
    expect(csvLine([-3, '-'])).toBe("-3,'-\r\n");
    // only the first character matters
    expect(csvLine(['a=b', 'x-y'])).toBe('a=b,x-y\r\n');
  });
});

describe('localDateTime', () => {
  it('writes an instant as YYYY-MM-DD HH:mm:ss on the wall clock of the zone', () => {
    const jakarta = localDateTime('Asia/Jakarta');
    expect(jakarta(new Date('2026-10-13T23:30:00Z'))).toBe(
      '2026-10-14 06:30:00',
    );
    expect(jakarta(new Date('2026-10-14T17:00:00.999Z'))).toBe(
      '2026-10-15 00:00:00',
    );
    // midnight is 00, not 24
    expect(localDateTime('UTC')(new Date('2026-01-01T00:00:00Z'))).toBe(
      '2026-01-01 00:00:00',
    );
    expect(
      localDateTime('America/New_York')(new Date('2026-11-01T06:30:00Z')),
    ).toBe('2026-11-01 01:30:00');
  });
});

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  ended = false;
  destroyed = false;
  writableEnded = false;
  /** What `write` answers: false means the socket buffer is full. */
  accept = true;

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return this.accept;
  }
  end() {
    this.ended = true;
    this.writableEnded = true;
  }
  get text() {
    return this.chunks.join('');
  }
}

/** A generator that records how far it was pulled and whether it was closed. */
function source(batches: unknown[][][], failAt?: number) {
  const state = { pulled: 0, closed: false };
  async function* run(): AsyncGenerator<unknown[][]> {
    try {
      for (const [i, batch] of batches.entries()) {
        await Promise.resolve(); // a real source awaits its query here
        if (i === failAt) throw new Error('query failed');
        state.pulled++;
        yield batch;
      }
      if (failAt === batches.length) throw new Error('query failed');
    } finally {
      state.closed = true;
    }
  }
  return { state, batches: run() };
}

const asResponse = (res: FakeResponse) => res as unknown as Response;
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('streamCsv', () => {
  it('writes the BOM and the header first, then every batch, then ends', async () => {
    const res = new FakeResponse();
    const { batches } = source([
      [[1, 'a']],
      [
        [2, 'b,c'],
        [3, 'd'],
      ],
    ]);

    await streamCsv(
      asResponse(res),
      ['n', 'text'],
      batches,
      new AbortController().signal,
      { 'Content-Type': 'text/csv; charset=utf-8' },
    );

    expect(res.headers).toEqual({ 'Content-Type': 'text/csv; charset=utf-8' });
    expect(res.chunks[0]).toBe(`${BOM}n,text\r\n`);
    expect(res.text).toBe(`${BOM}n,text\r\n1,a\r\n2,"b,c"\r\n3,d\r\n`);
    expect(res.ended).toBe(true);
  });

  it('waits for drain when the socket is full, and pulls no batch meanwhile', async () => {
    const res = new FakeResponse();
    res.accept = false;
    const { state, batches } = source([[[1]], [[2]], [[3]]]);

    const done = streamCsv(
      asResponse(res),
      ['n'],
      batches,
      new AbortController().signal,
    );
    await tick();
    await tick();
    // the first batch is read, the header is out and the socket says "full": nothing else moves
    expect(state.pulled).toBe(1);
    expect(res.text).toBe(`${BOM}n\r\n`);

    res.emit('drain');
    await tick();
    await tick();
    expect(res.text).toBe(`${BOM}n\r\n1\r\n`);
    // batch 1 is out and the socket is full again: still no second read
    expect(state.pulled).toBe(1);

    res.emit('drain');
    await tick();
    await tick();
    expect(state.pulled).toBe(2);
    res.accept = true;
    res.emit('drain');
    await done;
    expect(state.pulled).toBe(3);
    expect(res.ended).toBe(true);
  });

  it('stops reading and closes the source when the signal aborts, even while waiting for drain', async () => {
    const res = new FakeResponse();
    res.accept = false;
    const abort = new AbortController();
    const { state, batches } = source([[[1]], [[2]], [[3]]]);

    const done = streamCsv(asResponse(res), ['n'], batches, abort.signal);
    await tick();
    abort.abort();
    await done;

    expect(state.pulled).toBe(1);
    expect(state.closed).toBe(true);
    expect(res.ended).toBe(false);
  });

  it('a failure before the first byte leaves the response untouched', async () => {
    const res = new FakeResponse();
    const { state, batches } = source([[[1]]], 0);

    await expect(
      streamCsv(asResponse(res), ['n'], batches, new AbortController().signal, {
        'Content-Disposition': 'attachment',
      }),
    ).rejects.toThrow('query failed');

    expect(res.chunks).toEqual([]);
    expect(res.headers).toEqual({});
    expect(state.closed).toBe(true);
  });

  it('a failure after the first batch rejects and never ends the response', async () => {
    const res = new FakeResponse();
    const { batches } = source([[[1]], [[2]]], 1);

    await expect(
      streamCsv(asResponse(res), ['n'], batches, new AbortController().signal),
    ).rejects.toThrow('query failed');

    expect(res.text).toBe(`${BOM}n\r\n1\r\n`);
    expect(res.ended).toBe(false);
  });

  it('an empty result is still a file with its header', async () => {
    const res = new FakeResponse();
    const { batches } = source([]);

    await streamCsv(
      asResponse(res),
      ['a', 'b'],
      batches,
      new AbortController().signal,
    );

    expect(res.text).toBe(`${BOM}a,b\r\n`);
    expect(res.ended).toBe(true);
  });
});
