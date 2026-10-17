#!/bin/sh
# 清理各受管共享 .recycle 回收站中超过保留期的文件。
# vfs_recycle 由 Assay Agent 写入共享根下的 .recycle 目录（keeptree + versions），
# 本脚本删除超期文件并清掉因此空掉的目录（.recycle 本身保留）。
#
# 用法:  clean-recycle.sh [保留天数]        # 默认 30 天
# 环境:  RECYCLE_ROOT 默认 /data/samba-ad/shares（Agent 配置的 shares_root 卷内路径）
# 建议:  systemd timer 每日凌晨运行一次（参考 assay-operations 的既有定时任务）
set -eu

KEEP_DAYS="${1:-30}"
ROOT="${RECYCLE_ROOT:-/data/samba-ad/shares}"
case "$KEEP_DAYS" in
  ''|*[!0-9]*) echo "保留天数必须是非负整数" >&2; exit 1 ;;
esac
[ -d "$ROOT" ] || { echo "共享根目录不存在: $ROOT" >&2; exit 1; }

# 逐共享处理：先删超期文件，再自底向上清空目录（保留 .recycle 本身）
find "$ROOT" -maxdepth 3 -type d -name .recycle -prune -print0 |
while IFS= read -r -d '' bin; do
  find "$bin" -type f -mtime "+$KEEP_DAYS" -exec rm -f -- {} +
  find "$bin" -depth -mindepth 1 -type d -empty -exec rmdir -- {} +
done

echo "回收站清理完成（保留 ${KEEP_DAYS} 天，根目录 $ROOT）"
