import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
HOST=Path(__file__).resolve().parents[3]/'deploy/samba-production'
sys.path.insert(0,str(HOST))
spec=importlib.util.spec_from_file_location('company_maintenance',HOST/'maintenance.py')
maintenance=importlib.util.module_from_spec(spec);spec.loader.exec_module(maintenance)
import company


class CompanySafety(unittest.TestCase):
    def test_rename_overlay_keeps_ids_aliases_and_excluded_shares(self):
        source=b'[finance]\n valid users = @EXAMPLE\\finance\n vfs objects = recycle\n[common]\n valid users = @EXAMPLE\\common\n'
        catalog={'aliases':{'old_team':'finance'},'external':[{'id':'stable-guid','name':'finance','path':'old-path','groups':['finance']},{'id':'public','name':'common','groups':['common']}]}
        extra,full,selected=maintenance.overlay_policy(json.dumps(catalog).encode(),source,['finance'],'EXAMPLE','company_leadership')
        self.assertEqual(selected,['finance'])
        self.assertEqual(extra['aliases'],catalog['aliases'])
        self.assertEqual(extra['external'][0]['id'],'stable-guid')
        self.assertEqual(extra['external'][0]['path'],'old-path')
        self.assertEqual(extra['external'][1],catalog['external'][1])
        self.assertIn('company_leadership',extra['external'][0]['groups'])
        self.assertIn(b'acl_xattr recycle',full)
        self.assertEqual(full.split(b'[common]')[1],source.split(b'[common]')[1])
        blocked=maintenance.maintenance_admission(full,selected,'EXAMPLE\\service')
        self.assertIn(b'valid users = "EXAMPLE\\service"',blocked)
        self.assertNotIn(b'company_leadership',blocked)
        self.assertEqual(maintenance.overlay_policy(json.dumps(extra).encode(),full,['finance'],'EXAMPLE','company_leadership')[1],full)

    def test_runtime_qualification_rejects_application_changes_and_mismatched_release(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory);(state/'dist').mkdir()
            identity=dict(commit='original',sourceSha256='digest',version='1.0.0')
            images={k:{'imageId':k,'digest':'digest-'+k} for k in ('api','web','samba-agent')}
            ids={k:v['imageId'] for k,v in images.items()}
            verified={**identity,'imageIds':ids,'assets':{}}
            backup={**identity,'host':'host','directory':'/data/assay','proof':dict(completed=True,restoreVerified=True,backup='/backup',imageIds={'api':'old-api','web':'old-web'})}
            deployed={**identity,'host':'host','directory':'/data/assay','proof':dict(completed=True,dataPreserved=True,localAttachmentsPreserved=True,backup='/backup',imageIds=ids)}
            values={'release':{**identity,'images':images},'verified':verified,'upgrade':{**identity,'preserved':True,'rollbackCompatible':True,'targetImageIds':ids,'sourceImages':backup['proof']['imageIds']},'company-backup':backup,'company-deployed':deployed}
            for name,value in values.items():(state/(name+'.json')).write_text(json.dumps(value))
            manifest={**identity,'images':images,'assets':{},'verification':verified}
            (state/'dist/release-manifest.json').write_text(json.dumps(manifest))
            ci=SimpleNamespace(state=state,version='1.0.0',receipt=lambda _:None)
            with patch.object(company.subprocess,'check_output',return_value=''):
                self.assertEqual(company.published_runtime(ci,'host','/data/assay')['artifactSourceCommit'],'original')
            with patch.object(company.subprocess,'check_output',return_value='docs/runbook.md\0'):
                self.assertEqual(company.published_runtime(ci,'host','/data/assay')['releaseImageIds'],ids)
                with self.assertRaisesRegex(RuntimeError,'another target'):company.published_runtime(ci,'wrong','/data/assay')
                deployed['proof']['imageIds']={'api':'wrong'}
                (state/'company-deployed.json').write_text(json.dumps(deployed))
                with self.assertRaisesRegex(RuntimeError,'preservation proof'):company.published_runtime(ci,'host','/data/assay')
            with patch.object(company.subprocess,'check_output',return_value='agents/samba/src/main.rs\0'):
                with self.assertRaisesRegex(RuntimeError,'Application source changed'):company.published_runtime(ci,'host','/data/assay')

    def test_candidate_only_changes_selected_share_and_reapplication_is_idempotent(self):
        original=b'[common]\n valid users = @EXAMPLE\\common\n vfs objects = recycle\n[finance]\n valid users = @EXAMPLE\\finance\n path = /shares/finance\n vfs objects = recycle\n[scan]\n valid users = @EXAMPLE\\scan\n path = /shares/common/scans\n'
        result=maintenance.policy_config(original,['finance'],'EXAMPLE','company_leadership')
        self.assertEqual(result.split(b'[finance]')[0],original.split(b'[finance]')[0])
        self.assertEqual(result.split(b'[scan]')[1],original.split(b'[scan]')[1])
        self.assertIn(b'vfs objects = acl_xattr recycle',result)
        self.assertEqual(result,maintenance.policy_config(result,['finance'],'EXAMPLE','company_leadership'))

    def test_missing_share_or_ambiguous_access_rule_is_rejected_before_publication(self):
        for source in (b'[common]\nvalid users = @common\n',b'[finance]\nvalid users = @a\nvalid users = @b\n'):
            with self.assertRaises(AssertionError):maintenance.policy_config(source,['finance'],'EXAMPLE','company_leadership')

    def test_open_documents_prevent_any_ad_or_acl_policy_writes(self):
        c=object.__new__(maintenance.Company)
        c.p={'deployedImageIds':{},'departments':['finance'],'leaders':['boss_one','boss_two'],'leadershipGroup':'company_leadership'}
        c.ad={'Id':'ad'}
        snapshot={'users':[{'name':n,'disabled':False,'dn':'CN='+n} for n in c.p['leaders']], 'groups':[],
                  'shares':[{'name':'finance','external':True,'active':True}]}
        with tempfile.TemporaryDirectory() as directory:
            c.p['backup']=directory;(Path(directory)/'RESTORE_VERIFIED.json').touch()
            with patch.object(c,'image_ids',return_value={}),patch.object(c,'agent',return_value=snapshot), \
                    patch.object(c,'command') as commands,patch.object(maintenance,'run',return_value=json.dumps({'open_files':{'f':{}}}).encode()):
                with self.assertRaisesRegex(AssertionError,'Open SMB files'):c.policy()
                commands.assert_not_called()

    def test_deploy_cannot_load_images_after_the_source_runtime_changes(self):
        c=object.__new__(maintenance.Company)
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'RESTORE_VERIFIED.json').touch()
            c.p={'backup':directory,'sourceImageIds':{'api':'expected'}}
            with patch.object(c,'image_ids',return_value={'api':'changed'}),patch.object(maintenance,'run') as commands:
                with self.assertRaisesRegex(AssertionError,'Runtime changed'):c.deploy()
                commands.assert_not_called()


if __name__=='__main__':unittest.main()
