#!/usr/bin/env bash
# Explicit SSH deployment only; publish/release never invoke this file.
set -Eeuo pipefail
umask 077
deploy_dir=$1
operation=$2
version=$3
registry=$4
api_digest=$5
web_digest=$6
mode=$7
expected_api=$8
expected_web=$9
source_api=${10}
source_web=${11}
proxy_containers=${12}
[[ "$deploy_dir" == /* && "$operation" == "$deploy_dir"/backups/local-ci-* ]]
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$registry" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
for digest in "$api_digest" "$web_digest" "$expected_api" "$expected_web" "$source_api" "$source_web"; do
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
done
[[ "$mode" == online || "$mode" == offline ]]
cd "$deploy_dir"
[[ -f .env && -f docker-compose.yaml ]]
exec 9>/run/lock/assay-local-ci-deploy.lock
flock -n 9
cp -p .env "$operation/before.env"
cp -p docker-compose.yaml "$operation/before-compose.yaml"
old_api=$(docker compose ps -q api)
old_web=$(docker compose ps -q web)
[[ -n "$old_api" && -n "$old_web" ]]
old_api_id=$(docker inspect "$old_api" --format '{{.Image}}')
old_web_id=$(docker inspect "$old_web" --format '{{.Image}}')
[[ "$old_api_id" == "$source_api" && "$old_web_id" == "$source_web" ]] || {
  echo 'Production images changed after the upgrade rehearsal; rerun preflight.' >&2; exit 1;
}
old_api_ref=$(docker inspect "$old_api" --format '{{.Config.Image}}')
old_web_ref=$(docker inspect "$old_web" --format '{{.Config.Image}}')
for service in postgres redis rustfs; do
  docker compose ps -q "$service" > "$operation/before-$service.id"
done
python3 "$operation/tools/deploy_config.py" prepare "$deploy_dir" "$operation" "$version" "$registry" "$proxy_containers"

# Complete network/transfer work while the old application is still serving.
if [[ "$mode" == offline ]]; then
  (cd "$operation" && sha256sum -c images.sha256)
  docker load -i "$operation/images.tar.gz" > "$operation/image-load.log" 2>&1
else
  docker pull "$registry/assay-api@$api_digest"
  docker pull "$registry/assay-web@$web_digest"
fi
[[ "$(docker image inspect "$expected_api" --format '{{.Id}}')" == "$expected_api" ]]
[[ "$(docker image inspect "$expected_web" --format '{{.Id}}')" == "$expected_web" ]]
api_ref="$registry/assay-api:$version"
web_ref="$registry/assay-web:$version"
docker tag "$expected_api" "$api_ref"
docker tag "$expected_web" "$web_ref"
activated=false
stopped=false
rollback() {
  failure=$?
  trap - EXIT HUP INT TERM
  if [[ "$failure" != 0 && "$stopped" == true ]]; then
    recovered=true
    if [[ "$activated" == true ]]; then
      cp -p "$operation/before.env" .env &&
        cp -p "$operation/before-compose.yaml" docker-compose.yaml &&
        docker tag "$old_api_id" "$old_api_ref" &&
        docker tag "$old_web_id" "$old_web_ref" &&
        docker compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 180 api web || recovered=false
    else
      docker start "$old_api" "$old_web" >/dev/null || recovered=false
    fi
    if [[ "$recovered" == true ]]; then
      printf 'Deployment failed; previous API/Web restarted. Database was NOT overwritten. Backup: %s\n' "$operation" >&2
    else
      printf 'Deployment failed AND automatic API/Web recovery failed; manual recovery required. Database was NOT overwritten. Backup: %s\n' "$operation" >&2
    fi
  fi
  exit "$failure"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cmp -s .env "$operation/before.env"
cmp -s docker-compose.yaml "$operation/before-compose.yaml"

# Block user writes for the final backup and post-migration preservation audit.
stopped=true
docker stop --time 30 "$old_web" >/dev/null
BACKUP_S3_CLIENT=api-sdk BACKUP_QUIESCE_API=1 BACKUP_LEAVE_API_STOPPED=1 \
  bash "$operation/tools/backup.sh" "$operation/backup" "$deploy_dir/docker-compose.yaml"
while IFS= read -r sums; do
  (cd "$(dirname "$sums")" && sha256sum -c "$(basename "$sums")" >/dev/null)
done < <(find "$operation/backup" -type f -name SHA256SUMS)
python3 "$operation/tools/db_fingerprint.py" capture --output "$operation/data-before.json"
cmp -s .env "$operation/before.env"
cmp -s docker-compose.yaml "$operation/before-compose.yaml"
activated=true
cp -p "$operation/next.env" .env
cp -p "$operation/next-compose.yaml" docker-compose.yaml
python3 "$operation/tools/deploy_config.py" check "$deploy_dir" "$operation" "$version" "$registry" "$proxy_containers"
docker compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 180 api
[[ "$(docker inspect "$(docker compose ps -q api)" --format '{{.Image}}')" == "$expected_api" ]]
python3 "$operation/tools/db_fingerprint.py" capture --before "$operation/data-before.json" --output "$operation/data-after.json"
python3 "$operation/tools/db_fingerprint.py" compare --before "$operation/data-before.json" --after "$operation/data-after.json" > "$operation/data-preservation.json"
docker compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 180 web
[[ "$(docker inspect "$(docker compose ps -q web)" --format '{{.Image}}')" == "$expected_web" ]]
for service in postgres redis rustfs; do
  [[ "$(docker compose ps -q "$service")" == "$(cat "$operation/before-$service.id")" ]]
done
docker compose exec -T api node -e 'fetch("http://127.0.0.1:"+(Number(process.env.API_PORT)||3000)+"/health",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
public_url=$(docker compose exec -T api node -p process.env.AUTH_BASE_URL)
[[ "$public_url" == https://* && "$public_url" != *$'\n'* ]]
[[ "$(curl -sS -A 'Mozilla/5.0' --max-time 20 -o /dev/null -w '%{http_code}' "$public_url/")" == 200 ]]
[[ "$(curl -sS -A 'Mozilla/5.0' --max-time 20 -o /dev/null -w '%{http_code}' "$public_url/api/me")" == 401 ]]
printf 'Version %s deployed; existing records preserved; data-service containers retained. Backup: %s\n' "$version" "$operation"
