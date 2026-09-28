#!/usr/bin/env bash
# 备份运行中的 Compose 项目：PostgreSQL + RustFS 当前 S3 对象 + 恢复所需密钥。
# 用法：bash scripts/backup.sh [输出目录] [实际使用的 Compose 文件]
set -euo pipefail
umask 077

die() { printf '备份失败：%s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

need docker
need jq
need gzip
need sha256sum
need mktemp

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT_DIR="${1:-$ROOT/../assay-backups}"
COMPOSE_FILE="${2:-docker-compose.yaml}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2}"
case "$OUT_DIR" in /*) ;; *) OUT_DIR="$PWD/$OUT_DIR" ;; esac
case "$COMPOSE_FILE" in /*) ;; *) COMPOSE_FILE="$ROOT/$COMPOSE_FILE" ;; esac

[[ -f "$COMPOSE_FILE" ]] || die "Compose 文件不存在：$COMPOSE_FILE"
[[ "$(cd "$(dirname "$COMPOSE_FILE")" && pwd -P)" == "$ROOT" ]] ||
  die "Compose 文件必须位于部署目录 $ROOT，以确保备份同目录的 .env"
COMPOSE_FILE="$ROOT/$(basename "$COMPOSE_FILE")"
[[ -f "$ROOT/.env" ]] || die "缺少 $ROOT/.env（需要备份部署配置和 AUTH_SECRET）"
[[ ! -L "$OUT_DIR" ]] || die "输出目录不能是符号链接：$OUT_DIR"
[[ ! -e "$OUT_DIR" || -d "$OUT_DIR" ]] || die "输出目标不是目录：$OUT_DIR"
COMPOSE_HASH="$(sha256sum -- "$COMPOSE_FILE")"
COMPOSE_HASH="${COMPOSE_HASH%% *}"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
one_running_container() {
  local ids
  ids="$(compose ps --status running -q "$1")" || return 1
  [[ -n "$ids" && "$ids" != *$'\n'* ]] || die "服务 $1 必须恰有一个运行中的容器"
  printf '%s' "$ids"
}
container_env() {
  local lines line key="$2"
  lines="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1")" || return 1
  while IFS= read -r line; do
    case "$line" in "$key="*) printf '%s' "${line#*=}"; return 0 ;; esac
  done <<< "$lines"
  return 1
}
required_env() {
  local value
  value="$(container_env "$1" "$2")" || die "运行中的 $3 缺少 $2"
  [[ -n "$value" ]] || die "运行中的 $3 的 $2 为空"
  printf '%s' "$value"
}
verify_container() {
  local id="$1" service="$2" project="$3" actual_project actual_service actual_files
  actual_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id")" || return 1
  actual_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id")" || return 1
  [[ "$actual_project" == "$project" && "$actual_service" == "$service" ]] ||
    die "$service 容器不属于所选 Compose 项目 $project"
  actual_files="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id")" || return 1
  [[ "$actual_files" == "$COMPOSE_FILE" ]] ||
    die "$service 容器的 config_files 与所选 Compose 文件 $COMPOSE_FILE 不一致"
}
resolved_volume() {
  jq -er --arg service "$1" --arg target "$2" '
    ([.services[$service].volumes[]? | select(.target == $target and .type == "volume") | .source]
     | if length == 1 then .[0] else error("服务目标必须恰好挂载一个命名卷") end)
    as $source | .volumes[$source].name
    | select(type == "string" and length > 0)
  ' <<< "$CONFIG"
}

cd "$ROOT"
# config 会按 Compose 的项目名优先级、环境变量和卷声明解析实际资源名。
CONFIG="$(compose config --format json)" || die "Compose 配置无法解析"
PROJECT="$(jq -er '.name | select(type == "string" and length > 0)' <<< "$CONFIG")" || die "无法解析 Compose 项目名"
VOLUME="$(resolved_volume rustfs /data)" || die "无法解析 RustFS /data 的实际卷名"
PG_VOLUME="$(resolved_volume postgres /var/lib/postgresql/data)" ||
  die "无法解析 PostgreSQL /var/lib/postgresql/data 的实际卷名"

RUSTFS_ID="$(one_running_container rustfs)"
POSTGRES_ID="$(one_running_container postgres)"
API_ID="$(one_running_container api)"
verify_container "$RUSTFS_ID" rustfs "$PROJECT"
verify_container "$POSTGRES_ID" postgres "$PROJECT"
verify_container "$API_ID" api "$PROJECT"

MOUNT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{printf "%s %s\n" .Type .Name}}{{end}}{{end}}' "$RUSTFS_ID")" || die "无法检查 RustFS 挂载"
[[ "$MOUNT" == "volume $VOLUME" ]] || die "RustFS 实际挂载 '$MOUNT'，与 Compose 预期卷 '$VOLUME' 不一致"
docker volume inspect "$VOLUME" >/dev/null || die "附件卷不存在：$VOLUME"
PG_MOUNT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{printf "%s %s\n" .Type .Name}}{{end}}{{end}}' "$POSTGRES_ID")" ||
  die "无法检查 PostgreSQL 挂载"
[[ "$PG_MOUNT" == "volume $PG_VOLUME" ]] ||
  die "PostgreSQL 实际挂载 '$PG_MOUNT'，与 Compose 预期卷 '$PG_VOLUME' 不一致"
docker volume inspect "$PG_VOLUME" >/dev/null || die "PostgreSQL 卷不存在：$PG_VOLUME"

[[ "$(required_env "$API_ID" STORAGE_DRIVER api)" == s3 ]] || die "API 未使用 S3 存储"
[[ "$(required_env "$API_ID" S3_ENDPOINT api)" == http://rustfs:9000 ]] || die "API 的 S3_ENDPOINT 不是本项目 RustFS"
BUCKET="$(container_env "$API_ID" S3_BUCKET)" || BUCKET=assay-attachments
[[ -n "$BUCKET" ]] || BUCKET=assay-attachments
REGION="$(container_env "$API_ID" S3_REGION)" || REGION=us-east-1
[[ -n "$REGION" ]] || REGION=us-east-1
ACCESS_KEY="$(required_env "$API_ID" S3_ACCESS_KEY api)"
SECRET_KEY="$(required_env "$API_ID" S3_SECRET_KEY api)"
AUTH_SECRET="$(required_env "$API_ID" AUTH_SECRET api)"
[[ "$ACCESS_KEY" == "$(required_env "$RUSTFS_ID" RUSTFS_ACCESS_KEY rustfs)" &&
   "$SECRET_KEY" == "$(required_env "$RUSTFS_ID" RUSTFS_SECRET_KEY rustfs)" ]] ||
  die "API 与 RustFS 的 S3 凭据不一致"

POSTGRES_USER="$(required_env "$POSTGRES_ID" POSTGRES_USER postgres)"
POSTGRES_DB="$(required_env "$POSTGRES_ID" POSTGRES_DB postgres)"

printf '已核对项目 %s：RustFS 容器 %s，附件卷 %s，PostgreSQL 卷 %s，桶 %s。\n' \
  "$PROJECT" "$RUSTFS_ID" "$VOLUME" "$PG_VOLUME" "$BUCKET"
mkdir -p -- "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"
DEST="$(mktemp -d "$OUT_DIR/backup-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
printf 'INCOMPLETE: do not restore\n' > "$DEST/INCOMPLETE"
trap 'status=$?; if (( status != 0 )); then printf "备份中断，保留未完成目录：%s\n" "$DEST" >&2; fi' EXIT
cp -- "$COMPOSE_FILE" "$DEST/compose.yaml"
[[ "$(sha256sum -- "$DEST/compose.yaml")" == "$COMPOSE_HASH "* ]] ||
  die "所选 Compose 文件在解析后发生变化，备份已中止"
printf '[1/3] PostgreSQL 逻辑备份\n'
compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$DEST/db.sql.gz"
gzip -t "$DEST/db.sql.gz"

printf '[2/3] RustFS S3 对象备份\n'
printf '[default]\ns3 =\n    addressing_style = path\n' > "$DEST/.aws-config"
export AWS_ACCESS_KEY_ID="$ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$SECRET_KEY" AWS_DEFAULT_REGION="$REGION"
aws_cli() {
  docker run --rm --network "container:$RUSTFS_ID" \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$DEST,dst=/backup" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
    -e AWS_CONFIG_FILE=/backup/.aws-config -e AWS_EC2_METADATA_DISABLED=true \
    "$AWS_CLI_IMAGE" --endpoint-url http://127.0.0.1:9000 "$@"
}
aws_cli s3api head-bucket --bucket "$BUCKET" >/dev/null || die "附件桶不可访问：$BUCKET"
mkdir -m 700 "$DEST/objects"
aws_cli s3 sync "s3://$BUCKET/" /backup/objects/ --only-show-errors --no-progress
rm -- "$DEST/.aws-config"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION ACCESS_KEY SECRET_KEY

printf '[3/3] 已选 Compose、部署配置、运行中的 AUTH_SECRET 和 SHA-256 校验清单\n'
cp -- "$ROOT/.env" "$DEST/deployment.env"
chmod 600 "$DEST/deployment.env"
printf '%s\n' "$AUTH_SECRET" > "$DEST/auth-secret.txt"
unset AUTH_SECRET
printf 'project=%s\ncompose_file=%s\nrustfs_volume=%s\npostgres_volume=%s\npostgres_user=%s\npostgres_db=%s\ns3_bucket=%s\ns3_region=%s\n' \
  "$PROJECT" "$COMPOSE_FILE" "$VOLUME" "$PG_VOLUME" "$POSTGRES_USER" "$POSTGRES_DB" "$BUCKET" "$REGION" > "$DEST/backup-info.txt"
(cd "$DEST" && find compose.yaml db.sql.gz deployment.env auth-secret.txt backup-info.txt objects -type f -print0 |
  sort -z | xargs -0 sha256sum > SHA256SUMS)
(cd "$DEST" && sha256sum -c SHA256SUMS >/dev/null)
[[ "$(sha256sum -- "$COMPOSE_FILE")" == "$COMPOSE_HASH "* ]] ||
  die "所选 Compose 文件在备份期间发生变化，备份已中止"
rm -- "$DEST/INCOMPLETE"
printf '备份完成：%s\n' "$DEST"
