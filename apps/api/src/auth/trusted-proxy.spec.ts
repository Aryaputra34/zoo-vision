import { trustedProxy } from './trusted-proxy';

describe('trustedProxy', () => {
  it('trusts what the name resolves to, in either IPv4 spelling, and keeps the list when a lookup fails', async () => {
    const lookup = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValueOnce(['172.18.0.5'])
      .mockRejectedValueOnce(new Error('ENOTFOUND'));
    const proxy = trustedProxy('caddy', lookup);
    try {
      expect(proxy.trust('172.18.0.5')).toBe(false); // not resolved yet: nothing is trusted

      await proxy.refresh();
      expect(proxy.trust('172.18.0.5')).toBe(true);
      expect(proxy.trust('::ffff:172.18.0.5')).toBe(true);
      expect(proxy.trust('172.18.0.6')).toBe(false);

      await proxy.refresh(); // the lookup fails
      expect(proxy.trust('172.18.0.5')).toBe(true);
      expect(lookup).toHaveBeenCalledWith('caddy');
    } finally {
      proxy.stop();
    }
  });

  it('a new address replaces the old one', async () => {
    const lookup = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValueOnce(['10.0.0.1'])
      .mockResolvedValueOnce(['10.0.0.2']);
    const proxy = trustedProxy('caddy', lookup);
    try {
      await proxy.refresh();
      await proxy.refresh();
      expect(proxy.trust('10.0.0.1')).toBe(false);
      expect(proxy.trust('10.0.0.2')).toBe(true);
    } finally {
      proxy.stop();
    }
  });

  it('an address that is not there (a closed socket) is not trusted and does not throw', async () => {
    const proxy = trustedProxy('caddy', () => Promise.resolve(['10.0.0.1']));
    try {
      await proxy.refresh();
      expect(proxy.trust(undefined)).toBe(false);
    } finally {
      proxy.stop();
    }
  });

  it('asks again every 2 s while it knows no address (Caddy starts after the API)', async () => {
    jest.useFakeTimers();
    const lookup = jest
      .fn<Promise<string[]>, [string]>()
      .mockRejectedValueOnce(new Error('ENOTFOUND'))
      .mockResolvedValue(['10.0.0.9']);
    const proxy = trustedProxy('caddy', lookup);
    try {
      await proxy.refresh(); // what onModuleInit does: fails
      expect(proxy.trust('10.0.0.9')).toBe(false);
      await jest.advanceTimersByTimeAsync(2000);
      expect(proxy.trust('10.0.0.9')).toBe(true);
    } finally {
      proxy.stop();
      jest.useRealTimers();
    }
  });
});
