import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * SambaOperation 审计哈希链。
 *
 * 所有 sambaOperation 行（samba 命令、文件操作、目录身份联动）都必须经
 * appendOperation 写入，保证链不出现断裂的"旁路"行。
 *
 * 哈希输入覆盖 id、requestHash、action、actorId 与 metadata 的规范化
 * JSON：改动任何审计字段都会在校验时暴露。
 *
 * 旧行（chainHash 为 NULL）是迁移前写入的历史前缀，校验时跳过——
 * 它们之后的第一条链行以 NULL 为前驱，与写入侧一致。
 */

/** 审计链的固定编号：pg advisory lock 串行化并发追加，链头读取不竞争 */
export const CHAIN_LOCK_KEY = 918273645;

export function chainHash(
  previous: string | null,
  row: { id: string; requestHash: string; action: string; actorId: string; metadata: unknown },
) {
  const h = createHash('sha256');
  h.update(`${previous ?? ''}|${row.id}|${row.requestHash}|${row.action}|${row.actorId}|`);
  h.update(stableStringify(row.metadata));
  return h.digest('hex');
}

/** 键排序的确定性 JSON：对象键序不影响哈希 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface AuditRow {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  requestHash: string;
  metadata: unknown;
  state?: string;
}

/** 在事务内追加一条 SambaOperation 并接入哈希链 */
export async function appendOperation(tx: Prisma.TransactionClient, data: AuditRow) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`;
  // 只认链尾：跳过迁移前的 NULL 前缀行
  const last = await tx.sambaOperation.findFirst({
    where: { chainHash: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { chainHash: true },
  });
  return tx.sambaOperation.create({
    data: {
      ...data,
      metadata: data.metadata as object,
      chainHash: chainHash(last?.chainHash ?? null, data),
    },
  });
}

/** 独立事务版：文件/目录等没有外层事务的写入方使用 */
export async function appendAuditOperation(prisma: PrismaClient, data: AuditRow) {
  return prisma.$transaction((tx) => appendOperation(tx, data));
}

/** 校验审计哈希链：返回首个断点。 */
export async function verifyChain(prisma: PrismaClient) {
  const rows = await prisma.sambaOperation.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, requestHash: true, action: true, actorId: true, metadata: true, chainHash: true },
  });
  let previous: string | null = null;
  let brokenAt: string | null = null;
  for (const row of rows) {
    if (row.chainHash === null) continue;
    if (!brokenAt && row.chainHash !== chainHash(previous, row as never)) brokenAt = row.id;
    previous = row.chainHash;
  }
  return { total: rows.length, chained: rows.filter(r => r.chainHash !== null).length, valid: !brokenAt, brokenAt };
}
