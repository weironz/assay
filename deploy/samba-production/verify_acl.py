#!/usr/bin/env python3
"""Real SMB role probes inside the AD container; stdin parameters, no employee passwords.

Only creates a random temporary identity and uniquely named probe directories.
Never changes an existing user's password or an existing file's ACL/content.
"""
import gc
import json
import secrets
import sys

import ldb
from samba import NTSTATUSError
from samba.auth import system_session
from samba.credentials import Credentials, DONT_USE_KERBEROS, SMB_ENCRYPTION_REQUIRED, SMB_SIGNING_REQUIRED
from samba.param import LoadParm
from samba.samdb import SamDB
from samba.samba3 import param as smb_param
from samba.samba3.libsmb_samba_internal import Conn


def main(parameters):
    lp=LoadParm();lp.load_default()
    smb_lp=smb_param.get_context();smb_lp.load('/etc/samba/smb.conf')
    smb_lp.set('client signing','mandatory');smb_lp.set('client smb encrypt','required')
    db=SamDB(url=lp.private_path('sam.ldb'),session_info=system_session(),lp=lp)
    base=db.domain_dn()
    def find(name):
        rows=db.search(base=base,expression='(sAMAccountName='+ldb.binary_encode(name)+')',attrs=['objectGUID','objectSid','member','objectClass'])
        assert len(rows)==1,'Expected one exact AD account/group'
        return rows[0]
    leaders=parameters['leaders'];leadership=parameters['leadershipGroup'];departments=parameters['departments']
    group=find(leadership)
    expected={str(find(n).dn).lower() for n in leaders}
    assert {str(n).lower() for n in group.get('member',[])}==expected
    for name in parameters['departmentGroups']:assert b'group' in list(find(name)['objectClass'])
    name='qa_acl_'+secrets.token_hex(6);password='Qa9!'+secrets.token_urlsafe(30)
    prefix='__assay_acl_probe_'+secrets.token_hex(12)
    assert not db.search(base=base,expression='(sAMAccountName='+name+')',attrs=['objectGUID'])
    credentials=Credentials();credentials.guess(smb_lp);credentials.set_domain(lp.get('workgroup'))
    credentials.set_username(name);credentials.set_password(password);credentials.set_kerberos_state(DONT_USE_KERBEROS)
    credentials.set_smb_signing(SMB_SIGNING_REQUIRED);credentials.set_smb_encryption(SMB_ENCRYPTION_REQUIRED)
    guid=None;created=[];report={}
    def connect(share):return Conn('127.0.0.1',share,lp=smb_lp,creds=credentials)
    def denied(fn):
        try:fn()
        except NTSTATUSError as error:
            assert error.args[0]&0xffffffff==0xc0000022,'Expected SMB ACCESS_DENIED'
        else:raise AssertionError('Ordinary department member received a protected right')
    def handle(c,path,rights,disposition=1):
        return c.create(path,DesiredAccess=rights,ShareAccess=7,CreateDisposition=disposition)
    try:
        db.newuser(name,password,description='Assay temporary SMB permission acceptance; remove after test')
        guid=bytes(find(name)['objectGUID'][0])
        for share in departments:
            try:connect(share)
            except NTSTATUSError as error:
                # A hidden share may conceal admission denial as BAD_NETWORK_NAME.
                # Later successful department probes prove these shares exist.
                assert error.args[0]&0xffffffff in (0xc0000022,0xc00000cc)
            else:raise AssertionError('Unassigned employee was admitted to a department share')
        for group_name in parameters['departmentGroups']:db.add_remove_group_members(group_name,[name],add_members_operation=True)
        for share in departments:
            c=connect(share);c.mkdir(prefix);created.append(share)
            path=prefix+'\\probe.txt';payload=b'Assay controlled ACL acceptance\n'
            f=handle(c,path,0x12019f,2)
            try:c.write(f,payload,0);assert c.read(f,0,len(payload))==payload
            finally:c.close(f)
            denied(lambda:c.unlink(path));denied(lambda:c.rename(path,path+'.renamed'))
            def change_permissions():
                f=handle(c,path,0x40000);c.close(f)
            denied(change_permissions)
            report[share]={'staffReadWrite':True,'deleteDenied':True,'renameDenied':True,'ownerWriteDacDenied':True}
            del c;gc.collect()
        db.add_remove_group_members(leadership,[name],add_members_operation=True)
        for share in departments:
            c=connect(share);path=prefix+'\\probe.txt'
            f=handle(c,path,0x40000);c.close(f)
            c.unlink(path);c.rmdir(prefix)
            created.remove(share)
            report[share].update(leadershipDelete=True,leadershipWriteDac=True)
            del c;gc.collect()
    finally:
        if guid is not None:
            assert bytes(find(name)['objectGUID'][0])==guid,'Temporary identity changed; refuse cleanup of another object'
            # Cleanup only this invocation's random probe names, with the same
            # leadership role used in acceptance. Never touch customer files.
            if created:
                db.add_remove_group_members(leadership,[name],add_members_operation=True)
                for share in created:
                    try:
                        c=connect(share)
                        for file in ('probe.txt','probe.txt.renamed'):
                            try:c.unlink(prefix+'\\'+file)
                            except NTSTATUSError as error:
                                if error.args[0]&0xffffffff!=0xc0000034:raise
                        c.rmdir(prefix);del c;gc.collect()
                    except Exception:pass
            db.delete(find(name).dn)
            assert not db.search(base=base,expression='(sAMAccountName='+name+')',attrs=['objectGUID'])
            assert {str(n).lower() for n in find(leadership).get('member',[])}==expected
    assert not created,'Probe file cleanup incomplete'
    return {'passed':True,'shares':report,'unauthorizedSharesDenied':True,'temporaryIdentityRemoved':True,'leadershipMembersUnchanged':True,'existingEmployeePasswordsUsed':False}


if __name__=='__main__':
    print(json.dumps(main(json.load(sys.stdin))))
