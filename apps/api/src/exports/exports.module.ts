import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CsvResponder } from './csv-responder';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

@Module({
  imports: [ReportsModule],
  controllers: [ExportsController],
  providers: [ExportsService, CsvResponder],
  exports: [ExportsService, CsvResponder],
})
export class ExportsModule {}
