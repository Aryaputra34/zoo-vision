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
});
