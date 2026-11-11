"""Verify image identity across classic Docker and the containerd image store.

An OCI index/manifest digest and its config digest name different objects. Never
accept that difference without following and hashing the archived descriptor chain.
"""
import hashlib
import json
import re
import tarfile


def metadata(path):
    values={}
    with tarfile.open(path,'r|*') as archive:
        for entry in archive:
            if not entry.isfile() or entry.size>1024*1024:continue
            if entry.name not in ('index.json','manifest.json') and not re.fullmatch(r'blobs/sha256/[a-f0-9]{64}',entry.name):continue
            raw=archive.extractfile(entry).read()
            if entry.name.startswith('blobs/') and hashlib.sha256(raw).hexdigest()!=entry.name.rsplit('/',1)[1]:
                raise RuntimeError('OCI metadata checksum mismatch')
            try:values[entry.name]=json.loads(raw)
            except (ValueError,UnicodeDecodeError):continue
    return values


def config_digest(values, digest, depth=0):
    if depth>8 or not re.fullmatch(r'sha256:[a-f0-9]{64}',digest):raise RuntimeError('Invalid OCI descriptor chain')
    value=values.get('blobs/sha256/'+digest[7:])
    if not isinstance(value,dict):raise RuntimeError('OCI descriptor is missing')
    if value.get('os')=='linux' and value.get('architecture')=='amd64' and isinstance(value.get('rootfs'),dict):return digest
    if 'manifests' in value:
        children=[v for v in value['manifests'] if v.get('platform',{}).get('os')=='linux' and v.get('platform',{}).get('architecture')=='amd64']
        if len(children)!=1:raise RuntimeError('Require one Linux amd64 image in the OCI index')
        return config_digest(values,children[0]['digest'],depth+1)
    if 'config' in value:return config_digest(values,value['config']['digest'],depth+1)
    raise RuntimeError('Invalid Linux amd64 image config')


def allowed_ids(values, expected_config):
    result={expected_config}
    for descriptor in values.get('index.json',{}).get('manifests',[]):
        digest=descriptor['digest']
        try:actual=config_digest(values,digest)
        except RuntimeError:continue
        if actual==expected_config:result.add(digest)
    return result
