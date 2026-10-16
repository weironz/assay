"""Independent SMB acceptance client. Passwords arrive on stdin, never argv or logs."""
import base64, hashlib, json, sys
import smbclient
smbclient.ClientConfig(skip_dfs=True)
f=json.loads(sys.stdin.readline())
assert f['share'].startswith('qa_') and f['name'].startswith('qa_')
server=f['server'];port=int(f['port']);mode=f['mode'];root='\\\\'+server+'\\'+f['share']
target=root+'\\'+f.get('file','rename-probe.txt')
try:
    smbclient.register_session(server,username=f['domain']+'\\'+f['name'],password=f['password'],port=port,encrypt=True)
    if mode=='write':
        with smbclient.open_file(target,mode='wb',port=port) as stream:stream.write(base64.b64decode(f['data']))
    elif mode=='delete':smbclient.remove(target,port=port)
    elif mode=='list':print(json.dumps({'ok':True,'entries':smbclient.listdir(root,port=port)}),flush=True)
    else:
        with smbclient.open_file(target,mode='rb',port=port) as stream:
            if mode=='hold':
                print(json.dumps({'ready':True}),flush=True);sys.stdin.readline()
            data=stream.read()
        print(json.dumps({'ok':True,'sha256':hashlib.sha256(data).hexdigest(),'fileInode':smbclient.stat(target,port=port).st_ino,'rootInode':smbclient.stat(root,port=port).st_ino}),flush=True)
    if mode in ['write','delete']:print(json.dumps({'ok':True}),flush=True)
except Exception as error:
    text=str(error)
    status=getattr(error,'ntstatus',getattr(error,'status',None))
    codes={0xC0000022:'STATUS_ACCESS_DENIED',0xC00000CC:'STATUS_BAD_NETWORK_NAME',0xC000006D:'STATUS_LOGON_FAILURE',0xC0000034:'STATUS_OBJECT_NAME_NOT_FOUND',0xC000003A:'STATUS_OBJECT_PATH_NOT_FOUND',0xC0000225:'STATUS_NOT_FOUND'}
    known=codes.get(status,next((code for code in codes.values() if code in text),'SMB_PROBE_FAILED'))
    print(json.dumps({'ok':False,'error':known,'exceptionType':type(error).__name__,'status':status}),flush=True);sys.exit(3)
finally:smbclient.reset_connection_cache()
