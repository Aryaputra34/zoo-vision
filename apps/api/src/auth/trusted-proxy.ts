import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import dns from 'node:dns';
import { ENV, type Env } from '../config/env';

const REFRESH_MS = 60_000;
/** While no address is known (Caddy starts after the API), ask again soon: nothing is trusted meanwhile. */
const RETRY_MS = 2_000;

/** Every address a name resolves to. */
export type Lookup = (host: string) => Promise<string[]>;

const dnsLookup: Lookup = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/** `::ffff:172.18.0.5` (an IPv4 peer on a dual-stack socket) is `172.18.0.5`. */
const plain = (addr: string): string => addr.replace(/^::ffff:/i, '');

/**
 * The addresses `host` resolves to, re-resolved every minute (a container gets a new address when
 * it is recreated). A failed lookup keeps the last list; before the first success the list is
 * empty, so nothing is trusted and `req.ip` stays the socket address.
 */
export function trustedProxy(host: string, lookup: Lookup = dnsLookup) {
  let addresses = new Set<string>();

  const refresh = async (): Promise<void> => {
    try {
      addresses = new Set((await lookup(host)).map(plain));
    } catch {
      // keep the last list
    }
  };
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(
      () => void refresh().then(schedule),
      addresses.size > 0 ? REFRESH_MS : RETRY_MS,
    );
    timer.unref();
  };
  schedule();

  return {
    // A socket that already closed has no address: Express hands that over as undefined
    trust: (addr: string | undefined): boolean =>
      typeof addr === 'string' && addresses.has(plain(addr)),
    refresh,
    stop: (): void => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/**
 * Nest's handle on {@link trustedProxy}: resolves once before the app listens, stops with it.
 * `configureApp` hands `trust` to Express as the `trust proxy` setting.
 */
@Injectable()
export class TrustedProxy implements OnModuleInit, OnModuleDestroy {
  private readonly inner: ReturnType<typeof trustedProxy>;

  constructor(@Inject(ENV) env: Env) {
    this.inner = trustedProxy(env.TRUSTED_PROXY_HOST);
  }

  async onModuleInit(): Promise<void> {
    await this.inner.refresh();
  }

  onModuleDestroy(): void {
    this.inner.stop();
  }

  /** Express `trust proxy` function: only the hop next to us, and only when it is the proxy. */
  readonly trustHop = (addr: string | undefined, hop: number): boolean =>
    hop === 0 && this.inner.trust(addr);
}
