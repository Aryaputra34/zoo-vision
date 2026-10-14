import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../auth/password';
import { Role } from '../../generated/prisma/enums';

export class CreateUserDto {
  @ApiProperty({ pattern: '^[a-z0-9._-]{3,32}$' })
  @Matches(/^[a-z0-9._-]{3,32}$/)
  username!: string;

  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;

  @ApiProperty({ enum: Role, enumName: 'Role' })
  @IsEnum(Role)
  role!: Role;
}
