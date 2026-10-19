import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { EvidenceController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { PinJob } from './pin.job';

@Module({
  imports: [MediaModule],
  controllers: [EvidenceController],
  providers: [EvidenceService, PinJob],
  exports: [EvidenceService],
})
export class EvidenceModule {}
