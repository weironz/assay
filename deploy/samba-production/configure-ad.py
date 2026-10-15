#!/usr/bin/env python3
"""Deployment-only Samba library operation, executed inside the existing AD container.

Input and the rollback descriptor use stdin/stdout only. Never log either.
The Rust Agent does not invoke or depend on this program.
"""
import json
import sys
import ldb
from samba.auth import system_session
from samba.param import LoadParm
from samba.samdb import SamDB
from samba.sd_utils import SDUtils
from samba.dcerpc import security
from samba.ndr import ndr_unpack


def main():
    config = json.load(sys.stdin)
    lp = LoadParm()
    lp.load(config['smb_conf'])
    sam = SamDB(url=lp.private_path('sam.ldb'), session_info=system_session(), lp=lp)
    domain = str(sam.domain_dn())
    if domain.lower() != config['base_dn'].lower():
        raise RuntimeError('Domain differs from the reviewed deployment configuration')
    services = config['services_dn']
    # No account updates or password resets: a collision must stop the deployment.
    for account in config['accounts']:
        if sam.search(base=domain, expression='(sAMAccountName=' + ldb.binary_encode(account['name']) + ')', attrs=['dn']):
            raise RuntimeError('Service account already exists; reconcile explicitly')
    rollback = {'accounts': [], 'delegated_ous': {}, 'domain_sid': str(sam.get_domain_sid())}
    sam.transaction_start()
    try:
        for account in config['accounts']:
            sam.newuser(account['name'], account['password'],
                        userou=services[:-(len(domain) + 1)], force_password_change_at_next_login_req=False,
                        setpassword=True)
            result = sam.search(base=services, expression='(sAMAccountName=' + ldb.binary_encode(account['name']) + ')',
                                attrs=['objectSid', 'dn'])[0]
            dn = str(result.dn)
            # Credentials are rotated by operations; never keep deployment passwords in employee profiles.
            sam.toggle_userAccountFlags('(sAMAccountName=' + ldb.binary_encode(account['name']) + ')',
                                       0x10000, on=True)
            rollback['accounts'].append(dn)
            if account['management']:
                sid = str(ndr_unpack(security.dom_sid, result['objectSid'][0]))
                utility = SDUtils(sam)
                for ou in config['managed_ous']:
                    old = utility.read_sd_on_dn(ou)
                    rollback['delegated_ous'][ou] = old.as_sddl(security.dom_sid(sam.get_domain_sid()))
                    # GenericAll applies only to these OUs and their descendants, not the domain or built-ins.
                    utility.dacl_add_ace(ou, '(A;CI;GA;;;' + sid + ')')
        sam.transaction_commit()
    except BaseException:
        sam.transaction_cancel()
        raise
    print(json.dumps(rollback))


if __name__ == '__main__':
    main()
