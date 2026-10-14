import { Module } from '@nestjs/common';
import { ClipsService } from './clips.service';
import { MediaController } from './media.controller';

@Module({
  controllers: [MediaController],
  providers: [ClipsService],
})
export class MediaModule {}
