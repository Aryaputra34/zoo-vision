import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums';

/** A user as the API shows it. Never carries the password hash. */
export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: Role }) role!: Role;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: Date;

  static from(u: {
    id: string;
    username: string;
    name: string;
    role: Role;
    active: boolean;
    createdAt: Date;
  }): UserDto {
    return {
      id: u.id,
      username: u.username,
      name: u.name,
      role: u.role,
      active: u.active,
      createdAt: u.createdAt,
    };
  }
}
