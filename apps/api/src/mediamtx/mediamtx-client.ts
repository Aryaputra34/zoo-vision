/** Injection token: a {@link MediamtxClient}, or null when MEDIAMTX_API_URL is not set. */
export const MEDIAMTX = Symbol('MEDIAMTX');

/** A failed Control API call. Carries the status and the path name only: never a body or a URL. */
export class MediamtxError extends Error {
  override name = 'MediamtxError';
  constructor(
    readonly op: string,
    readonly path: string,
    readonly status: number | null,
    reason: string,
  ) {
    super(`path ${path}: ${op} failed (${status ?? reason})`);
  }
}

const TIMEOUT_MS = 5000;
const PER_PAGE = 100;

type Conf = Record<string, unknown>;
type Page = { pageCount: number; items: ({ name: string } & Conf)[] };

/** What a failed fetch says about itself, without its message (it can carry the URL). */
const reason = (err: unknown): string =>
  (err as { cause?: { code?: string } }).cause?.code ??
  (err as { name?: string }).name ??
  'error';

const enc = encodeURIComponent;

/** MediaMTX Control API v3, as user `zoo`. */
export class MediamtxClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    password: string,
  ) {
    this.auth = `Basic ${Buffer.from(`zoo:${password}`).toString('base64')}`;
  }

  /** The config of every path, following pages. Items carry `source`, which can hold credentials. */
  async listConfigs(): Promise<Map<string, Conf>> {
    const all = new Map<string, Conf>();
    for (let page = 0, pages = 1; page < pages; page++) {
      const res = await this.call(
        'list',
        '-',
        'GET',
        `/v3/config/paths/list?page=${page}&itemsPerPage=${PER_PAGE}`,
      );
      const body = (await res.json()) as Page;
      pages = body.pageCount;
      for (const { name, ...conf } of body.items) all.set(name, conf);
    }
    return all;
  }

  async add(name: string, conf: Conf): Promise<void> {
    await this.call(
      'add',
      name,
      'POST',
      `/v3/config/paths/add/${enc(name)}`,
      conf,
    );
  }

  async patch(name: string, conf: Conf): Promise<void> {
    await this.call(
      'patch',
      name,
      'PATCH',
      `/v3/config/paths/patch/${enc(name)}`,
      conf,
    );
  }

  /** A path that is already gone is fine. */
  async remove(name: string): Promise<void> {
    await this.call(
      'delete',
      name,
      'DELETE',
      `/v3/config/paths/delete/${enc(name)}`,
      undefined,
      [404],
    );
  }

  /** Runtime state (`ready`, `tracks2`, `bytesReceived`); null when MediaMTX has no such path. */
  async pathStatus(name: string): Promise<Record<string, unknown> | null> {
    const res = await this.call(
      'status',
      name,
      'GET',
      `/v3/paths/get/${enc(name)}`,
      undefined,
      [404],
    );
    return res.status === 404
      ? null
      : ((await res.json()) as Record<string, unknown>);
  }

  private async call(
    op: string,
    path: string,
    method: string,
    pathname: string,
    body?: Conf,
    okStatuses: number[] = [],
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(new URL(pathname, this.baseUrl), {
        method,
        headers: {
          Authorization: this.auth,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      throw new MediamtxError(op, path, null, reason(err));
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      throw new MediamtxError(op, path, res.status, 'error');
    }
    return res;
  }
}
