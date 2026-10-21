import { ApiProperty } from '@nestjs/swagger';

export class StreamPathInfoDto {
  @ApiProperty({ example: 'zv_gate' })
  name!: string;

  @ApiProperty({ enum: ['MAIN', 'SUB'], enumName: 'StreamChoice' })
  stream!: 'MAIN' | 'SUB';

  @ApiProperty({ description: 'MediaMTX has the stream and is receiving it' })
  ready!: boolean;

  @ApiProperty({ description: 'This path is the one being recorded' })
  recorded!: boolean;

  @ApiProperty({ type: [String], example: ['H264'] })
  codecs!: string[];

  @ApiProperty({
    enum: ['H265_BROWSER'],
    nullable: true,
    description: 'H265_BROWSER: a browser may not play this stream',
  })
  codecWarning!: 'H265_BROWSER' | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Measured from two readings 1-120 s apart; null until there are two',
  })
  bitrateBps!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Only on the recorded path: bitrate x 86400 x retention days (7 when the camera has none)',
  })
  estimatedBytes!: number | null;
}

export class DiskInfoDto {
  @ApiProperty() freeBytes!: number;
  @ApiProperty() totalBytes!: number;
}

export class StreamInfoDto {
  @ApiProperty({ type: [StreamPathInfoDto] })
  paths!: StreamPathInfoDto[];

  @ApiProperty({ description: "Bytes of this camera's kept clips" })
  evidenceBytes!: number;

  @ApiProperty({ description: "Number of this camera's kept clips" })
  evidenceCount!: number;

  @ApiProperty({
    type: DiskInfoDto,
    nullable: true,
    description: 'The recordings volume; null when it cannot be read',
  })
  disk!: DiskInfoDto | null;
}
