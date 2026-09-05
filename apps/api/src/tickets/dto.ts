import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { TicketContactDto } from './contact';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export class CreateTicketDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  body!: string; // 首条消息正文（P3 起为 HTML）

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional()
  @IsString()
  typeId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  /**
   * 下拉里没有合适分类时由提单人自填。与 categoryId 二选一，两者同时给出时
   * 以 categoryId 为准（下拉是受控数据，自由文本是兜底）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  categoryName?: string;

  @IsOptional()
  @IsString()
  queueId?: string;

  @IsOptional()
  @IsString()
  datacenterId?: string;

  @IsOptional()
  @IsString()
  clusterId?: string;

  /** 设备序列号，允许一次填多台（前端提示逗号分隔），故留长一些 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  serialNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TicketContactDto)
  contact?: TicketContactDto;

  /** 勾选后把这份联系方式存到用户档案，下次建单自动带出 */
  @IsOptional()
  @IsBoolean()
  saveContactAsDefault?: boolean;

  @IsOptional()
  @IsString({ each: true })
  attachmentIds?: string[]; // 建单前上传的草稿附件
}

export class UpdateTicketDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional()
  @IsString()
  typeId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  queueId?: string;

  @IsOptional()
  @IsString()
  datacenterId?: string;

  @IsOptional()
  @IsString()
  clusterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  serialNumber?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TicketContactDto)
  contact?: TicketContactDto;
}

export class AssignDto {
  @IsString()
  assigneeId!: string;

  @IsOptional()
  @IsString()
  queueId?: string;
}

export class TransitionDto {
  @IsIn(['start', 'hold', 'resume', 'resolve', 'close', 'reopen', 'cancel'])
  action!: string;
}

export class CreateMessageDto {
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsString()
  contentType?: string;

  /** 从协作区选择的 @ 提及对象；服务端仅接受本工单相关人员。 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mentionUserIds?: string[];
}

export class AddParticipantDto {
  @IsString()
  userId!: string;

  @IsIn(['COLLABORATOR', 'FOLLOWER'])
  role!: 'COLLABORATOR' | 'FOLLOWER';
}

export class ListTicketsQuery {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsString()
  queueId?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'priority', 'status'])
  sort?: string = 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';
}
