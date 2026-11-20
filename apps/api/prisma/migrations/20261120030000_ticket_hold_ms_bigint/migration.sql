-- Widen in place: preserve all accumulated durations and ticket records.
-- INTEGER milliseconds overflow after about 24.9 days (including repeated holds).
ALTER TABLE "tickets" ALTER COLUMN "hold_ms" TYPE BIGINT;
