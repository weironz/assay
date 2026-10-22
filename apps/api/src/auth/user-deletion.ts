import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Db = Pick<
  Prisma.TransactionClient,
  'ticket' | 'ticketMessage' | 'ticketAttachment' | 'inventoryOperation'
>;

// 必须覆盖 schema.prisma 中所有指向 user 的 required 外键（默认 Restrict /
// 显式 Restrict）：追加关系时必须在此登记，否则事务内删除会抛 P2003。
// 前端依赖这些名称提示用户「该账号已有 X 记录」，修改文案时注意配对。
const BLOCKING_QUERIES: Array<{
  label: string;
  count: (db: Db, userId: string) => Promise<number>;
}> = [
  {
    label: '工单',
    count: (db, userId) =>
      db.ticket.count({
        where: { OR: [{ requesterId: userId }, { assigneeId: userId }] },
      }),
  },
  { label: '回复', count: (db, userId) => db.ticketMessage.count({ where: { authorId: userId } }) },
  { label: '附件', count: (db, userId) => db.ticketAttachment.count({ where: { uploaderId: userId } }) },
  { label: '库存操作', count: (db, userId) => db.inventoryOperation.count({ where: { actorId: userId } }) },
];

/** 返回阻止删除该用户的业务记录类别（如 ['工单', '附件']）；空数组表示可以删。 */
export async function blockingUserRelations(db: Db, userId: string): Promise<string[]> {
  const blocking: string[] = [];
  for (const query of BLOCKING_QUERIES) {
    if ((await query.count(db, userId)) > 0) blocking.push(query.label);
  }
  return blocking;
}

/**
 * 统一的删除约束检查：用户自助注销（auth.ts beforeDelete）与管理员删除
 * （users.service remove）共用，避免两个入口的规则漂移。
 * 命中阻断记录时抛 ConflictException，由调用方按入口转换为合适的错误形态。
 */
export async function assertUserDeletable(db: Db, userId: string, hint: string) {
  const blocking = await blockingUserRelations(db, userId);
  if (blocking.length > 0) {
    throw new ConflictException(`该账号已有${blocking.join('、')}记录，无法删除。${hint}`);
  }
}
