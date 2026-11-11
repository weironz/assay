import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
HOST=Path(__file__).resolve().parents[3]/'deploy/samba-production'
sys.path.insert(0,str(HOST))
spec=importlib.util.spec_from_file_location('company_maintenance',HOST/'maintenance.py')
maintenance=importlib.util.module_from_spec(spec);spec.loader.exec_module(maintenance)


class CompanySafety(unittest.TestCase):
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
