import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export type SiteBranding = {
  siteName: string;
  brandSubtitle: string | null;
  brandLogoUrl: string | null;
};

export type SiteSettings = SiteBranding & {
  timeZone: string;
  recordingRetentionDays: number;
  snapshotRetentionDays: number;
  auditSnapshotRetentionDays: number;
  evidenceRetentionDays: number;
};

const FIELDS = {
  siteName: true,
  brandSubtitle: true,
  brandLogoUrl: true,
  timeZone: true,
  recordingRetentionDays: true,
  snapshotRetentionDays: true,
  auditSnapshotRetentionDays: true,
  evidenceRetentionDays: true,
} as const;

/** The migration's row; used only while the database has not answered yet. */
const DEFAULTS: SiteSettings = {
  siteName: 'MagniVision',
  brandSubtitle: null,
  brandLogoUrl: null,
  timeZone: 'Asia/Jakarta',
  recordingRetentionDays: 7,
  snapshotRetentionDays: 90,
  auditSnapshotRetentionDays: 365,
  evidenceRetentionDays: 365,
};

/**
 * The one `SiteSettings` row, held in memory so readers (report SQL, CSV times, jobs) never query it.
 * The app still boots with Postgres down (health answers 503): until the first successful load
 * the defaults stand in, and each read retries the load in the background.
 */
@Injectable()
export class SiteSettingsService implements OnModuleInit {
  private readonly log = new Logger(SiteSettingsService.name);
  // shortcut: a second API process would not see a PATCH; compose runs one api
  private copy: SiteSettings | undefined;
  private loading: Promise<SiteSettings> | undefined;
  private readonly defaults: SiteSettings;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ENV) env?: Env,
  ) {
    this.defaults = {
      ...DEFAULTS,
      siteName: env?.APP_NAME ?? DEFAULTS.siteName,
    };
  }

  async onModuleInit(): Promise<void> {
    await this.load().catch(() =>
      this.log.warn(
        'Site settings not loaded (database unreachable); using the defaults until it is',
      ),
    );
  }

  private load(): Promise<SiteSettings> {
    this.loading ??= this.prisma.siteSettings
      .findUniqueOrThrow({ where: { id: 1 }, select: FIELDS })
      .then((row) => (this.copy = row))
      .finally(() => (this.loading = undefined));
    return this.loading;
  }

  /**
   * The real settings, or a rejection while the database has not answered. For callers that act
   * on the values (path sync pushes a delete-after to MediaMTX; retention deletes files): the
   * defaults in {@link current} are only good enough to read.
   */
  loaded(): Promise<SiteSettings> {
    return this.copy ? Promise.resolve(this.copy) : this.load();
  }

  get current(): SiteSettings {
    if (!this.copy) void this.load().catch(() => undefined);
    return this.copy ?? this.defaults;
  }

  get branding(): SiteBranding {
    const { siteName, brandSubtitle, brandLogoUrl } = this.current;
    return { siteName, brandSubtitle, brandLogoUrl };
  }

  get timeZone(): string {
    return this.current.timeZone;
  }

  async update(
    patch: Partial<SiteSettings>,
  ): Promise<{ before: SiteSettings; after: SiteSettings }> {
    const before = this.copy ?? (await this.load());
    const after = await this.prisma.siteSettings.update({
      where: { id: 1 },
      data: patch,
      select: FIELDS,
    });
    this.copy = after;
    return { before, after };
  }
}
