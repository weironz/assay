import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { SYSTEM_ROLE_NAMES } from '../auth/role-policy';

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsIn(SYSTEM_ROLE_NAMES, { each: true })
  roleNames!: string[]; // ['handler'] 等
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsIn(SYSTEM_ROLE_NAMES, { each: true })
  roleNames?: string[];
}
