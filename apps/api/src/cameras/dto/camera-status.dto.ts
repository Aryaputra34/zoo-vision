import { ApiProperty } from '@nestjs/swagger';

/** What the engine publishes in `cam:{id}:status`. Times are epoch milliseconds. */
export class CameraStatusDto {
  state!: string;
  fps!: number;
  lastFrameAt!: number | null;
  /** The config version the engine runs; null until it reports one. */
  appliedVersion!: number | null;
  /** Why the engine rejected the latest config; null when it accepted it. */
  configError!: string | null;
  restarts!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: "The use case's live values (see its live schema)",
  })
  live!: Record<string, unknown>;
  updatedAt!: number;
}

export class CameraOnlineDto {
  online!: boolean;
  @ApiProperty({ type: CameraStatusDto, nullable: true })
  status!: CameraStatusDto | null;
}

export class CameraStatusEntryDto extends CameraOnlineDto {
  cameraId!: string;
}
