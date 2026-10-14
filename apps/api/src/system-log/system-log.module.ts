import { Module } from '@nestjs/common';
import { ExportsModule } from '../exports/exports.module';
import { ReportsModule } from '../reports/reports.module';
import { SystemLogController } from './system-log.controller';
import { SystemLogService } from './system-log.service';

@Module({
  imports: [ExportsModule, ReportsModule],
  controllers: [SystemLogController],
  providers: [SystemLogService],
})
export class SystemLogModule {}
