#!/usr/bin/env bash
# Executed over explicitly requested SSH only. publish/release never invoke this file.
set -Eeuo pipefail
umask 077
deploy_dir=$1
operation=$2
version=$3
registry=$4
api_digest=$5
web_digest=$6
[[ "$deploy_dir" == /* && "$operation" == "$deploy_dir"/backups/local-ci-* ]]
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$registry" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
[[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ && "$web_digest" =~ ^sha256:[0-9a-f]{64}$ ]]
cd "$deploy_dir"
[[ -f .env && -f docker-compose.yaml ]]
command -v flock >/dev/null
exec 9>/run/lock/assay-local-ci-deploy.lock
flock -n 9
cp -p .env "$operation/before.env"
cp -p docker-compose.yaml "$operation/before-compose.yaml"
old_api=$(docker compose ps -q api)
old_web=$(docker compose ps -q web)
[[ -n "$old_api" && -n "$old_web" ]]
old_api_id=$(docker inspect "$old_api" --format '{{.Image}}')
old_web_id=$(docker inspect "$old_web" --format '{{.Image}}')
old_api_ref=$(docker inspect "$old_api" --format '{{.Config.Image}}')
old_web_ref=$(docker inspect "$old_web" --format '{{.Config.Image}}')
for service in postgres redis rustfs; do
  docker compose ps -q "$service" > "$operation/before-$service.id"
done
# The existing backup tool checks the active config and volume identities and
# includes the database, current S3 objects and recovery configuration.
bash "$operation/tools/backup.sh" "$operation/backup" "$deploy_dir/docker-compose.yaml"
while IFS= read -r sums; do
  (cd "$(dirname "$sums")" && sha256sum -c "$(basename "$sums")")
done < <(find "$operation/backup" -type f -name SHA256SUMS)
api_ref="$registry/assay-api:$version"
web_ref="$registry/assay-web:$version"
docker pull "$registry/assay-api@$api_digest"
docker pull "$registry/assay-web@$web_digest"
new_api_id=$(docker image inspect "$registry/assay-api@$api_digest" --format '{{.Id}}')
new_web_id=$(docker image inspect "$registry/assay-web@$web_digest" --format '{{.Id}}')
docker tag "$new_api_id" "$api_ref"
docker tag "$new_web_id" "$web_ref"
changed=false
rollback() {
  failure=$?
  trap - EXIT HUP INT TERM
  if [[ "$failure" != 0 && "$changed" == true ]]; then
    cp -p "$operation/before.env" .env
    docker tag "$old_api_id" "$old_api_ref"
    docker tag "$old_web_id" "$old_web_ref"
    docker compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 180 api web || true
    printf 'Deployment failed; prior env/images restored. Backup: %s\n' "$operation" >&2
  fi
  exit "$failure"
}
trap rollback EXIT HUP INT TERM
changed=true
VERSION_FOR_ENV="$version" REGISTRY_FOR_ENV="$registry" python3 - <<'PY'
import os,pathlib,re
p=pathlib.Path('.env');lines=p.read_text().splitlines();values={'IMAGE_TAG':os.environ['VERSION_FOR_ENV'],'REGISTRY':os.environ['REGISTRY_FOR_ENV']}
result=[];seen=set()
for line in lines:
 key=line.split('=',1)[0] if '=' in line and not line.lstrip().startswith('#') else None
 if key in values:
  if key in seen:raise RuntimeError('Duplicate deployment environment key')
  seen.add(key);line=key+'='+values[key]
 result.append(line)
result += [key+'='+value for key,value in values.items() if key not in seen]
next_file=pathlib.Path('.env.local-ci-next');next_file.write_text('\n'.join(result)+'\n');next_file.chmod(p.stat().st_mode&0o777);os.chown(next_file,p.stat().st_uid,p.stat().st_gid);os.replace(next_file,p)
PY
changed=true
docker compose config --quiet
EXPECTED_API_REF="$api_ref" EXPECTED_WEB_REF="$web_ref" python3 - <<'PY'
import subprocess,json,os
c=json.loads(subprocess.check_output(['docker','compose','config','--format','json']))
assert c['services']['api']['image']==os.environ['EXPECTED_API_REF']
assert c['services']['web']['image']==os.environ['EXPECTED_WEB_REF']
assert 'seed' not in ' '.join(c['services']['api'].get('command',[])), 'Use the production no-seed API startup command'
PY
docker compose up -d --no-deps --force-recreate --pull never --wait --wait-timeout 180 api web
[[ "$(docker inspect "$(docker compose ps -q api)" --format '{{.Image}}')" == "$new_api_id" ]]
[[ "$(docker inspect "$(docker compose ps -q web)" --format '{{.Image}}')" == "$new_web_id" ]]
for service in postgres redis rustfs; do
  [[ "$(docker compose ps -q "$service")" == "$(cat "$operation/before-$service.id")" ]]
done
docker compose exec -T api node -e 'fetch("http://127.0.0.1:"+(Number(process.env.API_PORT)||3000)+"/health",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
public_url=$(docker compose exec -T api node -p process.env.AUTH_BASE_URL)
[[ "$public_url" == https://* && "$public_url" != *$'\n'* ]]
[[ "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$public_url/")" == 200 ]]
[[ "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$public_url/api/me")" == 401 ]]
printf 'Version %s deployed. Database/Redis/object-store containers retained. Backup: %s\n' "$version" "$operation"
