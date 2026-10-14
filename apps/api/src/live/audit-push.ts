import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { LiveGateway } from './live.gateway';

/**
 * A change to a camera with `auditCamera` set becomes an `audit.notice` for the `managers` room
 * (MANAGER and SUPERADMIN sockets, never a USER). Errors are logged and swallowed.
 */
@Injectable()
export class AuditPush implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AuditPush.name);
  private subscription?: Subscription;

  constructor(
    private readonly audit: AuditService,
    private readonly gateway: LiveGateway,
  ) {}

  onModuleInit(): void {
    this.subscription = this.audit.auditCamera$.subscribe((notice) => {
      try {
        this.gateway.toManagers('audit.notice', notice);
      } catch (err) {
        this.log.warn(
          `audit.notice failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
