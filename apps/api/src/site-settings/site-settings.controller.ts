import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { setAudit } from '../audit/audit-context';
import { MinRole } from '../auth/decorators';
import {
  SiteSettingsDto,
  UpdateSiteSettingsDto,
} from './dto/site-settings.dto';
import {
  type SiteSettings,
  SiteSettingsService,
} from './site-settings.service';

@Controller('site-settings')
export class SiteSettingsController {
  constructor(private readonly settings: SiteSettingsService) {}

  /** Any role: the web needs the time zone on every page. */
  @Get()
  @ApiOkResponse({ type: SiteSettingsDto })
  get(): SiteSettings {
    return this.settings.current;
  }

  @MinRole('SUPERADMIN')
  @Patch()
  @ApiOkResponse({ type: SiteSettingsDto })
  async update(
    @Body() dto: UpdateSiteSettingsDto,
    @Req() req: Request,
  ): Promise<SiteSettings> {
    const { before, after } = await this.settings.update(dto);
    const changed = (Object.keys(after) as (keyof SiteSettings)[]).filter(
      (k) => before[k] !== after[k],
    );
    setAudit(req, {
      action: 'site_settings.update',
      entity: 'site_settings',
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
    });
    return after;
  }
}
