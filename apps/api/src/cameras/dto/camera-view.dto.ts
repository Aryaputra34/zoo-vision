import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SourceType, StreamChoice } from '../../generated/prisma/enums';

export class CameraRecordingDto {
  enabled!: boolean;
  @ApiProperty({ enum: StreamChoice, enumName: 'StreamChoice' })
  stream!: StreamChoice;
  retentionDays!: number | null;
  clipBeforeSec!: number;
  clipAfterSec!: number;
}

/**
 * A camera as the caller's role sees it (`toCameraView`). Every role gets the first six fields;
 * MANAGER and SUPERADMIN also get the operating fields; only SUPERADMIN gets the stream URLs.
 */
export class LiveUrlsDto {
  @ApiProperty({
    description: 'WHEP URL of the main stream, behind Caddy and a session.',
    example: '/media/webrtc/zv_gate/whep',
  })
  main!: string;
  @ApiProperty({ type: String, nullable: true })
  sub!: string | null;
}

export class CameraViewDto {
  id!: string;
  name!: string;
  area!: string | null;
  useCase!: string;
  enabled!: boolean;
  activeVersion!: number;
  @ApiProperty({
    type: LiveUrlsDto,
    nullable: true,
    description:
      'Null for FILE or disabled cameras, and when the API has no MediaMTX configured (demo profile). The frontend never builds MediaMTX paths itself.',
  })
  liveUrls!: LiveUrlsDto | null;

  // MANAGER and SUPERADMIN
  @ApiPropertyOptional({ enum: SourceType, enumName: 'SourceType' })
  sourceType?: SourceType;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The MediaMTX path being recorded (zv_<id>, or zv_<id>_sub), derived from the recording settings. Null for FILE cameras or with recording off.',
  })
  recordingPath?: string | null;
  targetFps?: number;
  engineGroup?: string;
  auditCamera?: boolean;
  @ApiPropertyOptional({ enum: StreamChoice, enumName: 'StreamChoice' })
  inferenceStream?: StreamChoice;
  @ApiPropertyOptional({ type: String, nullable: true })
  nxCameraId?: string | null;
  recording?: CameraRecordingDto;
  createdAt?: Date;
  updatedAt?: Date;

  // SUPERADMIN only
  mainStreamUrl?: string;
  @ApiPropertyOptional({ type: String, nullable: true })
  subStreamUrl?: string | null;
}
