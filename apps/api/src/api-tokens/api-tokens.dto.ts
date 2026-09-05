import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { API_TOKEN_SCOPES, type ApiTokenScope } from './api-token-scopes';

export class CreateApiTokenDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(API_TOKEN_SCOPES, { each: true })
  scopes!: ApiTokenScope[];

  /** 不传表示永不过期；界面默认传 90 天。 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
