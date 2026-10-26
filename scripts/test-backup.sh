#!/usr/bin/env bash
# 隔离测试：所有 Docker 调用均由临时假命令处理，不访问真实容器或卷。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TEST_DIR="$(mktemp -d)"
case "$TEST_DIR" in /tmp/tmp.*|/tmp/assay-backup-*) ;; *) echo "不安全的测试目录：$TEST_DIR" >&2; exit 1 ;; esac
trap 'rm -rf -- "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/project/scripts" "$TEST_DIR/project/deploy/aliyun" "$TEST_DIR/bin"
cp "$SCRIPT_DIR/backup.sh" "$TEST_DIR/project/scripts/backup.sh"
printf 'AUTH_SECRET=fixture-secret\n' > "$TEST_DIR/project/.env"
printf 'name: standard-fixture\n' > "$TEST_DIR/project/docker-compose.yaml"
printf 'name: aliyun-fixture\n' > "$TEST_DIR/project/deploy/aliyun/docker-compose.yaml"
printf 'AUTH_SECRET=aliyun-fixture-secret\n' > "$TEST_DIR/project/deploy/aliyun/.env"
printf 'name: dev-fixture\n' > "$TEST_DIR/project/docker-compose.dev.yml"

cat > "$TEST_DIR/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_LOG"
if [[ "$1" == compose ]]; then
  file="$3"
  shift 3
  case "$file" in
    *aliyun*) logical=rustfs-data; pg_logical=pg-data ;;
    *) logical=rustfs-data-prod; pg_logical=pg-data-prod ;;
  esac
  project="${COMPOSE_PROJECT_NAME:-assay}"
  volume="${project}_$logical"
  case "$1" in
    config)
      jq -n --arg project "$project" --arg rustfs "$logical" --arg pg "$pg_logical" '
        {
          name: $project,
          services: {
            rustfs: {volumes: [{type: "volume", source: $rustfs, target: "/data"}]},
            postgres: {volumes: [{type: "volume", source: $pg, target: "/var/lib/postgresql/data"}]}
          },
          volumes: {
            ($rustfs): {name: ($project + "_" + $rustfs)},
            ($pg): {name: ($project + "_" + $pg)}
          }
        }'
      ;;
    ps)
      case "${*: -1}" in rustfs) echo rustfs-id ;; postgres) echo postgres-id ;; api) echo api-id ;; esac
      ;;
    exec)
      [[ "$MOCK_SCENARIO" != pg-fail ]] || exit 13
      if [[ "$MOCK_SCENARIO" == compose-drift ]]; then
        printf '# changed during backup\n' >> "$file"
      fi
      printf 'CREATE TABLE fixture (id integer);\n'
      ;;
    *) exit 90 ;;
  esac
elif [[ "$1" == inspect ]]; then
  format="$3"
  id="$4"
  project="${COMPOSE_PROJECT_NAME:-assay}"
  case "$format" in
    *com.docker.compose.project.config_files*)
      if [[ "$MOCK_SCENARIO" == "wrong-config-$id" ]]; then
        echo "${MOCK_SELECTED_PATH%/*}/docker-compose.dev.yml"
      else
        echo "$MOCK_SELECTED_PATH"
      fi
      ;;
    *com.docker.compose.project*)
      if [[ "$MOCK_SCENARIO" == wrong-project ]]; then echo another-project; else echo "$project"; fi
      ;;
    *com.docker.compose.service*) echo "${id%-id}" ;;
    *Mounts*)
      if [[ "$id" == postgres-id && "$MOCK_SCENARIO" == wrong-pg-mount ]]; then
        echo 'volume another_project_pg-data'
      elif [[ "$id" == postgres-id && "$MOCK_FILE" == *aliyun* ]]; then
        echo "volume ${project}_pg-data"
      elif [[ "$id" == postgres-id ]]; then
        echo "volume ${project}_pg-data-prod"
      elif [[ "$MOCK_SCENARIO" == wrong-mount ]]; then
        echo 'volume another_project_rustfs-data'
      elif [[ "$MOCK_FILE" == *aliyun* ]]; then
        echo "volume ${project}_rustfs-data"
      else
        echo "volume ${project}_rustfs-data-prod"
      fi
      ;;
    *Config.Env*)
      case "$id" in
        rustfs-id)
          printf 'RUSTFS_ACCESS_KEY=fixture-access\nRUSTFS_SECRET_KEY=fixture-password\n'
          ;;
        api-id)
          printf 'STORAGE_DRIVER=s3\nS3_ENDPOINT=http://rustfs:9000\nS3_BUCKET=fixture-bucket\nS3_REGION=us-east-1\nS3_ACCESS_KEY=fixture-access\nS3_SECRET_KEY=fixture-password\nAUTH_SECRET=runtime-secret\n'
          ;;
        postgres-id)
          printf 'POSTGRES_USER=fixture_user\nPOSTGRES_DB=fixture_db\n'
          ;;
      esac
      ;;
    *) exit 91 ;;
  esac
elif [[ "$1" == volume && "$2" == inspect ]]; then
  [[ "$MOCK_SCENARIO" != missing-volume ]] || exit 14
  [[ "$MOCK_SCENARIO" != missing-pg-volume || "$3" != *pg-data* ]] || exit 17
  echo '{}'
elif [[ "$1" == run ]]; then
  [[ "$*" != *'s3api head-bucket'* || "$MOCK_SCENARIO" != bucket-fail ]] || exit 15
  [[ "$*" != *'s3 sync'* || "$MOCK_SCENARIO" != sync-fail ]] || exit 16
  if [[ "$*" == *'s3 sync'* ]]; then
    for arg in "$@"; do
      case "$arg" in
        type=bind,src=*,dst=/backup)
          dest="${arg#type=bind,src=}"
          dest="${dest%,dst=/backup}"
          printf 'attachment bytes\n' > "$dest/objects/example.txt"
          ;;
      esac
    done
  fi
elif [[ "$1" == stop || "$1" == start ]]; then
  echo api-id
else
  exit 92
fi
MOCK
chmod +x "$TEST_DIR/bin/docker"

export PATH="$TEST_DIR/bin:$PATH"
export MOCK_LOG="$TEST_DIR/docker.log"
# Git Bash passes /data to Windows jq.exe as a Windows filesystem path unless disabled.
export MSYS_NO_PATHCONV=1
run_case() {
  local name="$1" scenario="$2" compose_file="$3" expected="$4" dest
  dest="$TEST_DIR/$name"
  : > "$MOCK_LOG"
  export MOCK_SCENARIO="$scenario" MOCK_FILE="$compose_file"
  export MOCK_SELECTED_PATH="$TEST_DIR/project/$compose_file"
  if bash "$TEST_DIR/project/scripts/backup.sh" "$dest" "$compose_file" > "$TEST_DIR/$name.stdout" 2> "$TEST_DIR/$name.stderr"; then
    [[ "$expected" == pass ]] || { echo "$name: 本应失败" >&2; exit 1; }
    local backup_dir
    backup_dir="$(find "$dest" -mindepth 1 -maxdepth 1 -type d -print -quit)"
    [[ -n "$backup_dir" && ! -e "$backup_dir/INCOMPLETE" ]]
    [[ "$(cat "$backup_dir/auth-secret.txt")" == runtime-secret ]]
    [[ "$(cat "$backup_dir/objects/example.txt")" == 'attachment bytes' ]]
    grep -Fxq 'postgres_user=fixture_user' "$backup_dir/backup-info.txt"
    grep -Fxq 'postgres_db=fixture_db' "$backup_dir/backup-info.txt"
    grep -Fq 'pg_dump -U fixture_user fixture_db' "$MOCK_LOG"
    cmp -s "$TEST_DIR/project/$compose_file" "$backup_dir/compose.yaml"
    cmp -s "$(dirname "$MOCK_SELECTED_PATH")/.env" "$backup_dir/deployment.env"
    grep -Eq '^[[:xdigit:]]{64} [ *]compose\.yaml$' "$backup_dir/SHA256SUMS"
    (cd "$backup_dir" && sha256sum -c SHA256SUMS >/dev/null)
  else
    [[ "$expected" == fail ]] || { echo "$name: 本应成功" >&2; cat "$TEST_DIR/$name.stderr" >&2; exit 1; }
    if [[ "$scenario" == missing-volume || "$scenario" == missing-pg-volume ||
          "$scenario" == wrong-mount || "$scenario" == wrong-pg-mount ||
          "$scenario" == wrong-project || "$scenario" == wrong-config-* ]]; then
      [[ ! -e "$dest" ]] || { echo "$name: 预检失败后写入了目标" >&2; exit 1; }
    else
      local backup_dir
      backup_dir="$(find "$dest" -mindepth 1 -maxdepth 1 -type d -print -quit)"
      [[ -f "$backup_dir/INCOMPLETE" ]]
    fi
  fi
  echo "PASS $name"
}

run_case standard ok docker-compose.yaml pass
grep -q 'assay_rustfs-data-prod' "$TEST_DIR/standard.stdout"
run_case aliyun ok deploy/aliyun/docker-compose.yaml pass
grep -q 'assay_rustfs-data' "$TEST_DIR/aliyun.stdout"
export COMPOSE_PROJECT_NAME=assay-fixture-override
run_case project_override ok docker-compose.yaml pass
grep -q 'assay-fixture-override_rustfs-data-prod' "$TEST_DIR/project_override.stdout"
unset COMPOSE_PROJECT_NAME
run_case missing_volume missing-volume docker-compose.yaml fail
run_case missing_pg_volume missing-pg-volume docker-compose.yaml fail
run_case wrong_mount wrong-mount deploy/aliyun/docker-compose.yaml fail
run_case wrong_pg_mount wrong-pg-mount deploy/aliyun/docker-compose.yaml fail
run_case wrong_project wrong-project docker-compose.yaml fail
run_case wrong_config_rustfs wrong-config-rustfs-id deploy/aliyun/docker-compose.yaml fail
run_case wrong_config_postgres wrong-config-postgres-id deploy/aliyun/docker-compose.yaml fail
run_case wrong_config_api wrong-config-api-id deploy/aliyun/docker-compose.yaml fail
run_case bucket_failure bucket-fail docker-compose.yaml fail
run_case sync_failure sync-fail docker-compose.yaml fail
run_case pg_failure pg-fail docker-compose.yaml fail
run_case compose_drift compose-drift docker-compose.yaml fail

# A quiesced backup must restore the original API even when object export fails.
export BACKUP_QUIESCE_API=1
run_case quiesced_success ok docker-compose.yaml pass
grep -Fxq 'stop --time 30 api-id' "$MOCK_LOG"
grep -Fxq 'start api-id' "$MOCK_LOG"
run_case quiesced_failure bucket-fail docker-compose.yaml fail
grep -Fxq 'start api-id' "$MOCK_LOG"
export BACKUP_LEAVE_API_STOPPED=1
run_case quiesced_deployment ok docker-compose.yaml pass
if grep -Fxq 'start api-id' "$MOCK_LOG"; then echo 'Deployment backup unexpectedly resumed API writes' >&2; exit 1; fi
unset BACKUP_QUIESCE_API BACKUP_LEAVE_API_STOPPED

# Fixture-only age command tests completion markers/checksums, not encryption.
mkdir "$TEST_DIR/age-bin"
cat > "$TEST_DIR/age-bin/age" <<'AGE'
#!/usr/bin/env bash
[[ "${MOCK_AGE_FAIL:-0}" == 0 ]] || exit 21
cp -- "$5" "$4"
AGE
chmod +x "$TEST_DIR/age-bin/age"
export MOCK_SCENARIO=ok MOCK_FILE=docker-compose.yaml
export MOCK_SELECTED_PATH="$TEST_DIR/project/docker-compose.yaml"
PATH="$TEST_DIR/age-bin:$PATH" BACKUP_AGE_RECIPIENT=fixture-recipient \
  bash "$TEST_DIR/project/scripts/backup.sh" "$TEST_DIR/encrypted" docker-compose.yaml >/dev/null
encrypted="$(find "$TEST_DIR/encrypted" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ ! -e "$encrypted/INCOMPLETE" && ! -e "$encrypted/auth-secret.txt" ]]
(cd "$encrypted" && sha256sum -c SHA256SUMS >/dev/null)
if PATH="$TEST_DIR/age-bin:$PATH" BACKUP_AGE_RECIPIENT=fixture-recipient MOCK_AGE_FAIL=1 \
  bash "$TEST_DIR/project/scripts/backup.sh" "$TEST_DIR/encryption-failed" docker-compose.yaml >/dev/null 2>&1; then
  echo 'Failed encryption marked backup complete' >&2; exit 1
fi
failed="$(find "$TEST_DIR/encryption-failed" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -f "$failed/INCOMPLETE" ]]
echo 'PASS encrypted_checksums_and_failure_marker'
