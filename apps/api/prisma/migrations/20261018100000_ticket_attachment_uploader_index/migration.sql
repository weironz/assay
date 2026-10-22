-- 附件配额按「上传者 + 24 小时窗口」统计，避免每次上传全表扫描。
-- CreateIndex
CREATE INDEX "ticket_attachments_uploader_id_created_at_idx" ON "ticket_attachments"("uploader_id", "created_at");
