import {
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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
  @IsString({ each: true })
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
  @IsString({ each: true })
  roleNames?: string[];
}
