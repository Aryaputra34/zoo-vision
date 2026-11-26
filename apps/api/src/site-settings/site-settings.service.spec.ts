import type { PrismaService } from '../prisma/prisma.service';
import { SiteSettingsService } from './site-settings.service';

describe('SiteSettingsService', () => {
  it('loaded() rejects while the database is down, then returns the real row; current falls back to defaults until then', async () => {
    const row = {
      siteName: 'MagniVision Demo',
      brandSubtitle: 'Video Analytics Platform',
      brandLogoUrl: '/branding/logo.svg',
      timeZone: 'Asia/Makassar',
      recordingRetentionDays: 30,
      snapshotRetentionDays: 60,
      auditSnapshotRetentionDays: 300,
      evidenceRetentionDays: 200,
    };
    const findUniqueOrThrow = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(row);
    const service = new SiteSettingsService({
      siteSettings: { findUniqueOrThrow },
    } as unknown as PrismaService);

    await service.onModuleInit(); // boots anyway
    expect(service.current.siteName).toBe('MagniVision');
    expect(service.current.recordingRetentionDays).toBe(7);
    expect(service.branding).toEqual({
      siteName: 'MagniVision',
      brandSubtitle: null,
      brandLogoUrl: null,
    });
    await expect(service.loaded()).resolves.toEqual(row);
    expect(service.current).toEqual(row);
    expect(service.branding).toEqual({
      siteName: 'MagniVision Demo',
      brandSubtitle: 'Video Analytics Platform',
      brandLogoUrl: '/branding/logo.svg',
    });
  });
});
