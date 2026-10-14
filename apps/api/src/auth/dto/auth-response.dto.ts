import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums';

/** What POST /auth/login answers: the user, never the password hash. */
export class LoginUserDto {
  id!: string;
  username!: string;
  name!: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role!: Role;
}

/** Who GET /auth/me says is calling: a logged-in user or an API token. */
export class ActorDto {
  @ApiProperty({ enum: ['user', 'token'] }) type!: 'user' | 'token';
  id!: string;
  name!: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role!: Role;
}
