"""Independent test client, never a dependency of the Rust Agent."""
import json,pathlib,sys
import smbclient
f=json.loads(pathlib.Path(sys.argv[1]).read_text());mode=sys.argv[2]
assert f['share'].startswith('qa_')
server=f.get('smb_server','127.0.0.1');port=int(f.get('smb_port',11445))
try:
 smbclient.register_session(server,username='ASSAY\\'+f['ad_name'],password=f['ad_password'],port=port,encrypt=True)
 target='\\\\'+server+'\\'+f['share']+'\\probe.txt'
 if mode=='write':
  with smbclient.open_file(target,mode='wb',port=port) as s:s.write(b'Assay permission verification\n')
 elif mode=='read':
  with smbclient.open_file(target,mode='rb',port=port) as s:assert s.read()==b'Assay permission verification\n'
 elif mode=='delete':smbclient.remove(target,port=port)
 else:raise ValueError('unknown mode')
 print(mode.upper()+'_OK')
except Exception as e:
 message=str(e).replace(f['ad_password'],'[redacted]')
 print('ACCESS_DENIED' if 'STATUS_ACCESS_DENIED' in message else 'SMB_ERROR: '+message);sys.exit(3)
finally:smbclient.reset_connection_cache()
