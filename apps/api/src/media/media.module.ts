import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClipsService } from './clips.service';
import { DebugFramesService } from './debug-frames.service';
import { MediaController } from './media.controller';
import { PlaybackService } from './playback.service';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [ClipsService, DebugFramesService, PlaybackService],
  exports: [PlaybackService],
})
export class MediaModule {}
