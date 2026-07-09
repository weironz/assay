#!/usr/bin/env bash
# 生产数据备份：PostgreSQL 逻辑备份 + RustFS 附件卷打包
# 用法：bash scripts/backup.sh [输出目录]   （默认 ./backups）
set -euo pipefail

OUT_DIR="${1:-./backups}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/$TS"
mkdir -p "$DEST"

COMPOSE="docker compose -f docker-compose.prod.yml"

echo "[1/2] 备份 PostgreSQL → $DEST/db.sql.gz"
$COMPOSE exec -T postgres sh -c 'pg_dump -U "${POSTGRES_USER:-assay}" "${POSTGRES_DB:-assay}"' \
  | gzip > "$DEST/db.sql.gz"

echo "[2/2] 备份 RustFS 附件卷 → $DEST/attachments.tar.gz"
# 通过临时容器挂载命名卷并打包（卷名 = 项目名_rustfs-data-prod）
VOL="$(docker volume ls -q | grep 'rustfs-data-prod' | head -1)"
if [ -n "$VOL" ]; then
  docker run --rm -v "$VOL":/data:ro -v "$(cd "$DEST" && pwd)":/backup alpine \
    sh -c 'cd /data && tar czf /backup/attachments.tar.gz .'
else
  echo "  ⚠️  未找到 rustfs-data-prod 卷，跳过附件备份"
fi

echo "✅ 备份完成：$DEST"
echo "   恢复 DB： gunzip -c $DEST/db.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres psql -U assay assay"
