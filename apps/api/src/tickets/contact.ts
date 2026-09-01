/**
 * 联系方式的取值表与校验。
 *
 * 存的是枚举键（ANY / WEEKDAY_9_18…）而不是「任何时间」这类展示文案：
 * 界面有四种语言，文案会随语言变，键不会。通知标题当初存了渲染好的中文，
 * 结果前端翻不了——这里不重蹈覆辙。
 */
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const CONTACT_POSITIONS = [
  'TECH_LEAD',
  'OPS_LEAD',
  'FINANCE',
  'CEO',
  'OTHER',
] as const;

export const CONTACT_TIMES = [
  'ANY',
  'WEEKDAY_9_18',
  'WEEKDAY_9_22',
  'DAILY_9_22',
  'NONE',
] as const;

/** 邮件提醒地址上限，与前端「添加邮件地址」的可点次数一致 */
export const MAX_CONTACT_EMAILS = 5;

export class TicketContactDto {
  @IsOptional()
  @IsIn(CONTACT_POSITIONS)
  position?: (typeof CONTACT_POSITIONS)[number];

  /**
   * 手机号不做格式校验：座机、分机、境外号码写法差别太大，
   * 一条正则挡住的多半是真实用户而不是脏数据。只限长度。
   */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  phone!: string;

  @IsIn(CONTACT_TIMES)
  callTime!: (typeof CONTACT_TIMES)[number];

  @IsIn(CONTACT_TIMES)
  smsTime!: (typeof CONTACT_TIMES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CONTACT_EMAILS)
  @IsEmail({}, { each: true })
  emails?: string[];
}
