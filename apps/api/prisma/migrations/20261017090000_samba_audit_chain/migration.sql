-- 审计哈希链：现有行为 NULL（未入链的历史前缀），新写入的行由 API 在事务内链接
-- 注意：SambaOperation 模型无 @map，列名用 Prisma 默认的驼峰形式（与 actorId 等一致）
ALTER TABLE "samba_operations" ADD COLUMN "chainHash" TEXT;
