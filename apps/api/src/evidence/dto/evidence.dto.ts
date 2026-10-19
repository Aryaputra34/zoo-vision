import { ApiProperty } from '@nestjs/swagger';
import { EvidenceReason, EvidenceStatus } from '../../generated/prisma/enums';

export class EvidenceDto {
  @ApiProperty() eventId!: string;
  @ApiProperty({ enum: EvidenceStatus, enumName: 'EvidenceStatus' })
  status!: EvidenceStatus;
  @ApiProperty({ enum: EvidenceReason, enumName: 'EvidenceReason' })
  reason!: EvidenceReason;
}
