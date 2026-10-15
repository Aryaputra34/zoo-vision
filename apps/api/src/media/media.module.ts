import { Module } from '@nestjs/common';
import { ClipsService } from './clips.service';
import { DebugFramesService } from './debug-frames.service';
import { MediaController } from './media.controller';

@Module({
  controllers: [MediaController],
  providers: [ClipsService, DebugFramesService],
})
export class MediaModule {}
