-- 对象删除 outbox：业务记录删除时把待删 key 持久化，失败可重试并告警。
CREATE TABLE "attachment_deletion_tasks" (
    "id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_deletion_tasks_pkey" PRIMARY KEY ("id")
);

-- 后台任务只扫「到期未完成」的行，按 next_attempt_at 取批。
CREATE INDEX "attachment_deletion_tasks_next_attempt_at_idx" ON "attachment_deletion_tasks"("next_attempt_at");
