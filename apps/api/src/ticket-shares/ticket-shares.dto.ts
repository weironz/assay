import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateTicketShareDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  /** 不传表示永不过期；受控范围避免误设一个数十年的公开链接。 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
