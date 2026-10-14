import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums';

export class ApiTokenDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role!: Role;
  @ApiProperty() prefix!: string;
  @ApiProperty({ description: 'Username of the creator' }) createdBy!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) lastUsedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) revokedAt!: Date | null;
}

/** Returned once, by POST. `token` is never retrievable again. */
export class CreatedApiTokenDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role!: Role;
  @ApiProperty() prefix!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ description: 'Shown only in this response' }) token!: string;
}
