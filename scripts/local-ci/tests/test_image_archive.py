import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from image_archive import metadata,config_digest,allowed_ids


class ImageIdentity(unittest.TestCase):
    def fixture(self,archive,tamper=False):
        blobs={}
        def blob(v):
            raw=json.dumps(v).encode();digest='sha256:'+hashlib.sha256(raw).hexdigest()
            blobs['blobs/sha256/'+digest[7:]]=raw;return digest
        config=blob({'os':'linux','architecture':'amd64','rootfs':{'type':'layers','diff_ids':[]},'config':{'Env':['EXAMPLE=true']}})
        manifest=blob({'config':{'digest':config},'layers':[]})
        index=blob({'manifests':[{'digest':manifest,'platform':{'os':'linux','architecture':'amd64'}},
            {'digest':'sha256:'+'f'*64,'platform':{'os':'unknown','architecture':'unknown'}}]})
        blobs['index.json']=json.dumps({'manifests':[{'digest':index}]}).encode()
        if tamper:blobs['blobs/sha256/'+config[7:]]=b'{}'
        with tarfile.open(archive,'w:gz') as t:
            for path,raw in blobs.items():
                entry=tarfile.TarInfo(path);entry.size=len(raw);t.addfile(entry,io.BytesIO(raw))
        return config,manifest,index

    def test_index_config_identity_is_proved_not_assumed(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'images.tar.gz';config,manifest,index=self.fixture(path)
            values=metadata(path)
            self.assertEqual(config_digest(values,index),config)
            self.assertEqual(config_digest(values,manifest),config)
            self.assertEqual(allowed_ids(values,config),{config,manifest,index})
            self.assertEqual(allowed_ids(values,'sha256:'+'e'*64),{'sha256:'+'e'*64})

    def test_tampered_config_or_missing_descriptor_cannot_be_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'images.tar.gz';self.fixture(path,tamper=True)
            with self.assertRaisesRegex(RuntimeError,'checksum'):metadata(path)
        with self.assertRaises(RuntimeError):config_digest({},'sha256:'+'a'*64)

    def test_ambiguous_or_other_platform_indexes_are_rejected(self):
        for children in ([],[{'platform':{'os':'linux','architecture':'arm64'}}],
                         [{'platform':{'os':'linux','architecture':'amd64'}}]*2):
            with self.assertRaises(RuntimeError):
                config_digest({'blobs/sha256/'+'a'*64:{'manifests':children}},'sha256:'+'a'*64)
