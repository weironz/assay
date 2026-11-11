#!/usr/bin/env python3
"""Task/Ansible controller for the existing company file-server deployment."""
import argparse
import datetime
import fcntl
import gzip
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess

import deployment
from run import Pipeline, clean_source, sha256


def published_runtime(ci, host, directory, recovering=False):
    """Qualify the immutable installed release separately from current ops code."""
    ci.receipt('test-deployment')
    required=('release','verified','upgrade','company-backup')+(() if recovering else ('company-deployed',))
    values={name:json.loads((ci.state/(name+'.json')).read_text()) for name in required}
    manifest=json.loads((ci.state/'dist/release-manifest.json').read_text())
    identity={k:manifest[k] for k in ('commit','sourceSha256','version')}
    if identity['version']!=ci.version or any(any(v.get(k)!=value for k,value in identity.items()) for v in values.values()):
        raise RuntimeError('Installed release provenance does not match')
    changed=[n for n in subprocess.check_output(['git','diff','--name-only','-z','--no-renames',manifest['commit'],'HEAD'],text=True).split('\0') if n]
    if any(not (n in ('Taskfile.yml','README.md') or n.startswith(('scripts/local-ci/','deploy/ansible/','deploy/samba-production/','docs/'))) for n in changed):
        raise RuntimeError('Application source changed; use the full release/deployment pipeline')
    release=values['release'];verified=values['verified'];upgrade=values['upgrade']
    if manifest['images']!=release['images'] or manifest['verification']!=verified:
        raise RuntimeError('Published manifest verification differs')
    images={k:v['imageId'] for k,v in manifest['images'].items()}
    if set(images)!={'api','web','samba-agent'} or images!=verified['imageIds'] or images!=upgrade['targetImageIds'] or not upgrade.get('preserved') or not upgrade.get('rollbackCompatible'):
        raise RuntimeError('Published release lacks matching upgrade verification')
    if manifest['assets']!=verified['assets'] or any(sha256(ci.state/'dist'/n)!=v for n,v in manifest['assets'].items()):
        raise RuntimeError('Published binary checksums differ')
    for key in ('company-backup',)+(() if recovering else ('company-deployed',)):
        row=values[key]
        if row['host']!=host or row['directory']!=directory or not row['proof'].get('completed'):
            raise RuntimeError('Installed release proof belongs to another target')
    backup=values['company-backup']['proof']
    if not backup.get('restoreVerified'):
        raise RuntimeError('Installed release lacks a verified backup')
    deployed={} if recovering else values['company-deployed']['proof']
    if not recovering and (not deployed.get('dataPreserved') or not deployed.get('localAttachmentsPreserved') or deployed['backup']!=backup['backup'] or deployed['imageIds']!=images):
        raise RuntimeError('Installed release lacks preservation proof')
    if upgrade['sourceImages']!={k:backup['imageIds'][k] for k in ('api','web')}:
        raise RuntimeError('Upgrade rehearsal belongs to another backup')
    result=dict(backup=backup['backup'],sourceImageIds=backup['imageIds'],releaseImageIds=images,artifactSourceCommit=manifest['commit'])
    if recovering:result['images']=manifest['images']
    else:result['deployedImageIds']=deployed.get('runtimeImageIds',images)
    return result


def check_rehearsal(folder, checks):
    expected={'db.sql.gz','objects.tar.gz','objects-manifest.json','backup-info.txt','source.json','source-images.tar.gz'}
    if set(checks)!=expected or any(sha256(folder/name)!=digest for name,digest in checks.items()):
        raise RuntimeError('Private company rehearsal download checksum mismatch')


def run(action):
    ci = Pipeline()
    lock = (ci.state.parent / 'pipeline.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    host, _, directory = deployment.target()
    clean_source()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    operation = directory + '/rollback/task-' + action + '-' + stamp + '-' + secrets.token_hex(3)
    parameters = {'action': action, 'directory': directory, 'operation': operation, 'version': ci.version}
    bundle = ''
    rehearsal = ''
    if action == 'backup':
        rehearsal = os.environ['LOCAL_CI_UPGRADE_BACKUP_DIR']
        folder = Path(rehearsal).expanduser().resolve()
        from run import ROOT
        if not Path(rehearsal).is_absolute() or folder == ROOT or ROOT in folder.parents or folder == Path('/'):
            raise RuntimeError('Keep private company rehearsal data outside the repository')
        folder.mkdir(parents=True,mode=0o700,exist_ok=True);folder.chmod(0o700)
        if any(folder.iterdir()):raise RuntimeError('Use an empty private company rehearsal directory')
    if action in ('runtime','resume'):
        parameters.update(published_runtime(ci,host,directory,recovering=action=='resume'))
        if action=='resume':
            prior=Path(os.environ['SAMBA_RESUME_OPERATION'])
            if prior.parent!=Path(directory)/'rollback' or not re.fullmatch(r'task-deploy-\d{8}T\d{6}Z-[a-f0-9]{6}',prior.name):
                raise RuntimeError('Select the exact original deployment operation under this target rollback directory')
            parameters['resumeOperation']=str(prior)
    elif action in ('policy','verify'):
        runtime=ci.receipt('company-runtime')
        if runtime['host']!=host or runtime['directory']!=directory or not runtime['proof'].get('runtimeHealthy'):
            raise RuntimeError('Recheck the selected installed release before policy maintenance')
        proof=runtime['proof']
        parameters.update(backup=proof['backup'],sourceImageIds=proof['sourceImageIds'],deployedImageIds=proof['runtimeImageIds'])
    elif action != 'backup':
        # A recheck explicitly revalidates an existing data backup after tooling
        # changes. It never reuses stale test/build/publish/deployment receipts.
        backup = json.loads((ci.state/'company-backup.json').read_text()) if action=='recheck' else ci.receipt('company-backup')
        if backup['version']!=ci.version or not backup['proof'].get('restoreVerified'):
            raise RuntimeError('Select a verified backup for this release')
        if backup['host'] != host or backup['directory'] != directory:
            raise RuntimeError('Company backup belongs to another target')
        parameters['backup'] = backup['proof']['backup']
        parameters['sourceImageIds'] = backup['proof']['imageIds']
    if action == 'deploy':
        ci.receipt('release'); ci.verified_artifacts()
        upgrade = ci.receipt('upgrade')
        images = ci.receipt('push-images')['images']
        if not upgrade.get('preserved') or not upgrade.get('rollbackCompatible') or upgrade['targetImageIds'] != ci.receipt('build-images')['imageIds']:
            raise RuntimeError('Rehearse the company production copy before deployment')
        if upgrade['sourceImages'] != {k:parameters['sourceImageIds'][k] for k in ('api','web')}:
            raise RuntimeError('Upgrade rehearsal belongs to another production source')
        parameters['images'] = images
        parameters['offline'] = os.getenv('DEPLOY_OFFLINE') == 'true'
        if parameters['offline']:
            ci.local_docker()
            references = [images[k]['reference'] for k in ('api','web','samba-agent')]
            for key in ('api','web','samba-agent'):
                actual = subprocess.check_output(['docker','image','inspect',images[key]['reference'],'--format','{{.Id}}'],env=ci.env,text=True).strip()
                if actual != images[key]['imageId']:
                    raise RuntimeError('Offline image differs from the verified release')
            bundle = str(ci.state / 'company-images.tar.gz')
            saved = subprocess.Popen(['docker','save',*references],stdout=subprocess.PIPE,env=ci.env)
            with gzip.open(bundle,'wb',compresslevel=6) as stream:
                shutil.copyfileobj(saved.stdout,stream)
            saved.stdout.close()
            if saved.wait(): raise RuntimeError('Company image export failed')
            parameters['bundleSha256'] = sha256(bundle)
    if action in ('policy','verify'):
        names = json.loads(os.environ['SAMBA_POLICY_DEPARTMENTS'])
        leaders = json.loads(os.environ['SAMBA_POLICY_LEADERS'])
        group = os.environ['SAMBA_POLICY_LEADERSHIP_GROUP']
        for values in (names,leaders,[group]):
            if not isinstance(values,list) or not values or len(set(values)) != len(values) or not all(isinstance(v,str) and re.fullmatch(r'[a-z][a-z0-9_-]{1,47}',v) for v in values):
                raise RuntimeError('Explicit unique department, leader and group names are required')
        if any(v in ('common','scan','test','sysvol','netlogon') for v in names):
            raise RuntimeError('Protected/public/test shares are excluded from bulk department policy')
        parameters.update(departments=names,leaders=leaders,leadershipGroup=group)
        limit=int(os.getenv('SAMBA_POLICY_MAX_ENTRIES','10000'))
        if not 1<=limit<=100000:raise RuntimeError('Reviewed ACL entry limit must be between 1 and 100000')
        parameters['maxEntries']=limit
        if action == 'verify':
            applied=ci.receipt('company-policy')['proof']
            if any(applied[key]!=parameters[key] for key in ('departments','leaders','leadershipGroup')):
                raise RuntimeError('Acceptance scope must match the applied company policy')
    proof = deployment.execute({'assay_operation': operation, 'assay_parameters': parameters, 'assay_bundle': bundle,'assay_rehearsal_directory':rehearsal},profile='samba')
    if proof.get('action') != action or proof.get('directory') != directory or proof.get('version') != ci.version or proof.get('completed') is not True:
        raise RuntimeError('Company maintenance completion proof does not match')
    if action == 'deploy' and proof.get('imageIds') != {k:v['imageId'] for k,v in parameters['images'].items()}:
        raise RuntimeError('Company runtime image IDs differ from the release')
    if action == 'policy' and set(proof.get('departments',[])) != set(parameters['departments']):
        raise RuntimeError('Department policy completion scope does not match')
    if action in ('runtime','resume'):
        for key,expected in [('imageIds',parameters['releaseImageIds']),('artifactSourceCommit',parameters['artifactSourceCommit'])]:
            if proof.get(key)!=expected:raise RuntimeError('Installed runtime attestation differs from release')
        if action=='runtime' and proof.get('runtimeImageIds')!=parameters['deployedImageIds']:raise RuntimeError('Installed image IDs changed')
        if action=='resume':
            if proof.get('recoveredDeploymentOperation')!=parameters['resumeOperation'] or not proof.get('deploymentDataPreserved'):
                raise RuntimeError('Original deployment completion could not be recovered')
            if set(proof.get('runtimeImageIds',{}))!=set(parameters['images']) or any(proof['runtimeImageIds'][k] not in (v['imageId'],v['digest']) for k,v in parameters['images'].items()):
                raise RuntimeError('Recovered runtime differs from published images')
        folder=Path(os.environ['LOCAL_CI_UPGRADE_BACKUP_DIR'])
        checks=json.loads((folder/'SHA256.json').read_text())
        if proof.get('rehearsalChecksums')!=checks:raise RuntimeError('Host and controller rehearsal differ')
        check_rehearsal(folder,checks)
    if action in ('backup','recheck'):
        if action=='recheck':rehearsal=os.environ['LOCAL_CI_UPGRADE_BACKUP_DIR']
        folder=Path(rehearsal)
        checks=json.loads((folder/'SHA256.json').read_text())
        if action=='recheck' and proof.get('rehearsalChecksums')!=checks:
            raise RuntimeError('Local rehearsal export differs from the reverified host backup')
        expected={'db.sql.gz','objects.tar.gz','objects-manifest.json','backup-info.txt','source.json','source-images.tar.gz'}
        if set(checks)!=expected:raise RuntimeError('Private company rehearsal download is incomplete')
        for name,digest in checks.items():
            if name not in ('db.sql.gz','objects.tar.gz','objects-manifest.json','backup-info.txt','source.json','source-images.tar.gz') or sha256(folder/name)!=digest:
                raise RuntimeError('Private company rehearsal download checksum mismatch')
            (folder/name).chmod(0o600)
        subprocess.run(['docker','load','-i',str(folder/'source-images.tar.gz')],check=True,env=ci.env)
    ci.mark({'backup':'company-backup','recheck':'company-backup','deploy':'company-deployed','runtime':'company-runtime','resume':'company-runtime','policy':'company-policy','verify':'company-verified'}[action],host=host,directory=directory,proof=proof)
    print(json.dumps(proof,ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','recheck','deploy','runtime','resume','policy','verify'])
    args=parser.parse_args()
    run(args.action)
