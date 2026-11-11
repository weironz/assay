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
    if action != 'backup':
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
        deployed=ci.receipt('company-deployed')['proof']
        parameters['deployedImageIds'] = deployed.get('runtimeImageIds',deployed['imageIds'])
        names = json.loads(os.environ['SAMBA_POLICY_DEPARTMENTS'])
        leaders = json.loads(os.environ['SAMBA_POLICY_LEADERS'])
        group = os.environ['SAMBA_POLICY_LEADERSHIP_GROUP']
        for values in (names,leaders,[group]):
            if not isinstance(values,list) or not values or len(set(values)) != len(values) or not all(isinstance(v,str) and re.fullmatch(r'[a-z][a-z0-9_-]{1,47}',v) for v in values):
                raise RuntimeError('Explicit unique department, leader and group names are required')
        if any(v in ('common','scan','test','sysvol','netlogon') for v in names):
            raise RuntimeError('Protected/public/test shares are excluded from bulk department policy')
        parameters.update(departments=names,leaders=leaders,leadershipGroup=group)
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
    ci.mark({'backup':'company-backup','recheck':'company-backup','deploy':'company-deployed','policy':'company-policy','verify':'company-verified'}[action],host=host,directory=directory,proof=proof)
    print(json.dumps(proof,ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','recheck','deploy','policy','verify'])
    args=parser.parse_args()
    run(args.action)
