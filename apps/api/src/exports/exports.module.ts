import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { CsvResponder } from './csv-responder';
import { ExportJobsController } from './export-jobs.controller';
import { ExportJobsService } from './export-jobs.service';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { PdfJob } from './pdf.job';

@Module({
  imports: [ReportsModule],
  controllers: [ExportsController, ExportJobsController],
  providers: [ExportsService, ExportJobsService, PdfJob, CsvResponder],
  exports: [ExportsService, CsvResponder],
})
export class ExportsModule {}
