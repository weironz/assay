-- 历史数据回填：把「没绑定 message_id、但正文里引用了下载地址」的附件绑定到
-- 对应的工单消息，之后才能安全地收紧未绑定附件的可见性（仅上传者/内部参与方）。
--
-- 分三类处理：
-- 1. ticket_id 为空的历史草稿：正文已经发到某张工单里，但附件记录还停在草稿
--    状态。回填时同时补 ticket_id 和 message_id；同一附件被多处引用时优先
--    内部备注（is_internal DESC），再取最早消息。
-- 2. message_id 已存在但 ticket_id 为空的脏数据：按消息补 ticket_id。
-- 3. ticket_id 已存在的附件：只补 message_id。
-- 同一张图既被内部备注、又被公开回复引用时，绑定到内部备注，这样迁移后它
-- 仍然只对内部可见，不会因为公开正文也引用了它而泄露。
WITH "draft_matches" AS (
    SELECT DISTINCT ON (a."id")
        a."id" AS "attachment_id",
        m."ticket_id" AS "ticket_id",
        m."id" AS "message_id"
    FROM "ticket_attachments" AS a
    JOIN "ticket_messages" AS m
      ON strpos(m."body", '/attachments/' || a."id" || '/download') > 0
    WHERE a."message_id" IS NULL
      AND a."ticket_id" IS NULL
    ORDER BY a."id", m."is_internal" DESC, m."created_at" ASC
)
UPDATE "ticket_attachments" AS a
SET "ticket_id" = d."ticket_id",
    "message_id" = d."message_id"
FROM "draft_matches" AS d
WHERE a."id" = d."attachment_id";

-- 另一类脏数据：message_id 已有值，但 ticket_id 还停在草稿状态。补上工单归属，
-- 否则下载接口会把已绑定消息的附件当成草稿，只允许上传者访问。
UPDATE "ticket_attachments" AS a
SET "ticket_id" = m."ticket_id"
FROM "ticket_messages" AS m
WHERE a."ticket_id" IS NULL
  AND a."message_id" IS NOT NULL
  AND m."id" = a."message_id";

UPDATE "ticket_attachments" AS a
SET "message_id" = (
    SELECT m."id"
    FROM "ticket_messages" AS m
    WHERE m."ticket_id" = a."ticket_id"
      AND strpos(m."body", '/attachments/' || a."id" || '/download') > 0
    ORDER BY m."is_internal" DESC, m."created_at" ASC
    LIMIT 1
)
WHERE a."message_id" IS NULL
  AND a."ticket_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "ticket_messages" AS m
    WHERE m."ticket_id" = a."ticket_id"
      AND strpos(m."body", '/attachments/' || a."id" || '/download') > 0
  );
