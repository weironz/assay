import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import StepUpDialog from '../../components/StepUpDialog';
import { stepUpHeaders } from '../../lib/security-step-up';
import { awaitOperation } from './operations';
import { OperationError } from '../../lib/operation-error';
import {
  Badge,
  DataTable,
  EditorDialog,
  button,
  card,
  link,
} from './components';
import {
  displayDomain,
  profileFields,
  type Editor,
  type Snapshot,
} from './types';
import { Employees } from './Employees';
import { groupNameError } from './group-policy';
import { Groups } from './Groups';
import { Shares } from './Shares';
import { Bindings } from './Bindings';

type Pending = {
  title: string;
  endpoint: string;
  body: unknown;
  onSuccess?: () => void;
};
type Operation = {
  id: string;
  createdAt: string;
  actorName: string;
  action: string;
  state: string;
  metadata: unknown;
  result: unknown;
};
const titles: Record<string, string> = {
  users: '员工账号',
  groups: '用户组',
  shares: '共享目录',
  bindings: '登录账号关联',
  history: '操作记录',
};
const descriptions: Record<string, string> = {
  users: '管理员工资料、公司 AD 账号状态及所属用户组',
  groups: '按团队或岗位管理成员，通过用户组分配文件访问权限',
  shares: '管理共享目录、访问用户组及目录内的 Windows 权限',
  bindings: '关联 Assay 登录账号与公司 AD 账号，供员工自助修改 AD 密码',
  history: '查看公司目录管理操作的执行状态和结果',
};
const states: Record<string, string> = {
  succeeded: '已完成',
  failed: '失败',
  uncertain: '结果待核对',
  pending: '执行中',
  queued: '排队中',
  running: '执行中',
};
const actions: Record<string, string> = {
  'user.rename':'重命名登录账号',
  'group.rename':'重命名用户组',
  'share.rename':'重命名共享',
  'user.create': '新增员工',
  'user.update': '编辑员工资料',
  'user.password': '重置 AD 密码',
  'user.change_password': '自助修改 AD 密码',
  'group.create': '新增用户组',
  'group.update': '编辑用户组',
  'group.member': '调整成员',
  'group.members': '批量调整成员',
  'group.delete': '删除用户组',
  'share.save': '保存共享目录',
  'share.remove': '移除共享',
  'directory.create': '新建目录',
  'directory.delete': '删除空目录',
  'acl.grant': '调整目录权限',
  'identity.bind': '关联登录账号',
  'identity.unbind': '解除账号关联',
};
function errorMessage(e: unknown) {
  if (e instanceof OperationError) return e.message;
  const value = e as {
    response?: { data?: { message?: string } };
    message?: string;
  };
  return (
    value.response?.data?.message ||
    value.message ||
    '请求失败，请检查连接与操作记录'
  );
}

export default function SambaPage() {
  const { has } = useAuth();
  const { section = 'users', id } = useParams();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<Operation[]>([]);
  const [refresh, setRefresh] = useState(0);
  async function load() {
    setBusy(true);
    try {
      setSnapshot((await api.get('/samba/snapshot')).data);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    setError('');
    setNotice('');
  }, [section, id]);
  useEffect(() => {
    if (section === 'history')
      void api
        .get('/samba/operations')
        .then((r) => setHistory(r.data))
        .catch((e) => setError(errorMessage(e)));
  }, [section, refresh]);
  const open = (e: Editor) => {
    setError('');
    setNotice('');
    setEditor(e);
  };
  const confirm = (
    title: string,
    action: string,
    args: unknown,
    onSuccess?: () => void,
  ) => {
    setError('');
    setNotice('');
    setPending({
      title,
      endpoint: '/samba/commands',
      body: { requestId: crypto.randomUUID(), action, args },
      onSuccess,
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const args = { ...editor.values };
    if (editor.action === 'group.create') {
      const prefix = snapshot?.groupPrefix || '';
      const value = typeof args.name === 'string' ? args.name : '';
      const message = groupNameError(value, prefix, snapshot?.groups.map(group => group.name) || [], snapshot?.users.map(user => user.name) || []);
      if (message) { setEditor({ ...editor, error: message }); return; }
    }
    if (['user.create', 'user.password'].includes(editor.action) &&
        (typeof args.password !== 'string' || args.password.length < 8 || args.password.length > 512 || args.password.includes('\0'))) {
      setEditor({ ...editor, error: '新的 AD 密码需为 8–512 个字符，且不能包含空字符。' });
      return;
    }
    if (['user.create', 'user.update'].includes(editor.action)) {
      args.profile = Object.fromEntries(
        profileFields.map((f) => [f.name, args[f.name]]),
      );
      for (const field of profileFields) delete args[field.name];
    }
    if (
      editor.action === 'group.members' &&
      (!(args.user_ids as string[]).length ||
        (args.user_ids as string[]).length > 100)
    ) {
      setError('请一次选择 1 至 100 名员工');
      return;
    }
    if (
      editor.action === 'share.save' &&
      (args.groups as string[]).length > 100
    ) {
      setError('一个共享目录最多允许 100 个用户组');
      return;
    }
    setPending({
      title: editor.title,
      endpoint: editor.endpoint || '/samba/commands',
      body: editor.endpoint
        ? args
        : { requestId: crypto.randomUUID(), action: editor.action, args },
    });
    setEditor(null);
  };
  const complete = async (token: string) => {
    if (!pending) return;
    try {
      const response = await api.post(pending.endpoint, pending.body, {
        headers: stepUpHeaders(token),
      });
      if (pending.endpoint.endsWith('/commands'))
        await awaitOperation(response.data);
      pending.onSuccess?.();
      setNotice('操作已完成');
      setError('');
      await load();
    } catch (e) {
      const code = (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
      const failure = code ? new OperationError(code) : e;
      setError(errorMessage(failure));
      throw failure;
    }
  };
  if (
    !titles[section] ||
    (id && !['users', 'groups', 'shares'].includes(section))
  )
    return <Navigate to="/samba/users" replace />;
  const name =
    section === 'users'
      ? snapshot?.users.find((u) => u.id === id)?.displayName
      : section === 'groups'
        ? snapshot?.groups.find((g) => g.id === id)?.name
        : snapshot?.shares.find(s=>s.id===id||s.name===id)?.name || id;
  const workspace = snapshot
    ? {
        snapshot,
        canWrite: has('samba:manage') && !snapshot.readOnly && !busy,
        open,
        confirm,
      }
    : null;
  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <nav
        aria-label="面包屑"
        className="flex flex-wrap items-center gap-2 text-sm text-gray-500"
      >
        <Link to="/samba/overview">文件管理</Link>
        <span>/</span>
        <Link className={link} to={`/samba/${section}`}>
          {titles[section]}
        </Link>
        {id && (
          <>
            <span>/</span>
            <span className="break-all">{name || '详情'}</span>
          </>
        )}
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {titles[section]}
            {id ? '详情' : ''}
          </h1>
          <p className="mt-2 text-sm text-gray-500">{descriptions[section]}</p>
        </div>
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            setError('');
            void load();
          }}
        >
          刷新
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg bg-green-50 p-4 text-sm text-green-800 dark:bg-green-950/30 dark:text-green-300"
        >
          {notice}
        </p>
      )}
      {!snapshot && (
        <p role="status" className="p-8 text-gray-500">
          正在加载公司目录…
        </p>
      )}
      {snapshot?.enabled === false && (
        <div className={card + ' p-6'}>
          尚未配置公司目录连接，请联系部署管理员。
        </div>
      )}
      {workspace && snapshot?.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <Badge>{displayDomain(snapshot.domain)}</Badge>
            <span>公司 AD 目录</span>
            {snapshot.readOnly && <Badge muted>只读模式</Badge>}
            <span>成员或权限变更后，重新连接文件共享以刷新访问权限。</span>
          </div>
          {section === 'users' && <Employees {...workspace} id={id} />}
          {section === 'groups' && (
            <Groups key={id || 'list'} {...workspace} id={id} />
          )}
          {section === 'shares' && (
            <Shares
              key={id || 'list'}
              {...workspace}
              id={id}
              refresh={refresh}
              onError={setError}
            />
          )}
          {section === 'bindings' && (
            <Bindings
              {...workspace}
              unlink={(userId) =>
                setPending({
                  title: '解除登录账号关联',
                  endpoint: '/samba/bindings',
                  body: { userId, adObjectId: null },
                })
              }
            />
          )}
          {section === 'history' && (
            <DataTable
              label="操作记录"
              rows={history}
              rowKey={(h) => h.id}
              searchText={(h) =>
                h.actorName +
                ' ' +
                (actions[h.action] || h.action) +
                ' ' +
                (states[h.state] || h.state)
              }
              columns={[
                {
                  label: '时间',
                  render: (h) => new Date(h.createdAt).toLocaleString(),
                },
                { label: '操作人', render: (h) => h.actorName },
                { label: '操作', render: (h) => actions[h.action] || h.action },
                {
                  label: '状态',
                  render: (h) => (
                    <Badge muted={h.state !== 'succeeded'}>
                      {states[h.state] || h.state}
                    </Badge>
                  ),
                },
                {
                  label: '详情',
                  render: (h) => (
                    <details>
                      <summary className={link + ' cursor-pointer'}>
                        查看结果
                      </summary>
                      <pre className="mt-2 max-w-md overflow-auto whitespace-pre-wrap break-all text-xs">
                        {JSON.stringify(
                          { parameters: h.metadata, result: h.result },
                          null,
                          2,
                        )}
                      </pre>
                      {['pending', 'queued', 'running', 'uncertain'].includes(
                        h.state,
                      ) && (
                        <button
                          className={button}
                          onClick={async () => {
                            try {
                              await api.get(`/samba/operations/${h.id}`);
                              setHistory(
                                (await api.get('/samba/operations')).data,
                              );
                            } catch (e) {
                              setError(errorMessage(e));
                            }
                          }}
                        >
                          核对执行结果
                        </button>
                      )}
                    </details>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      {editor && (
        <EditorDialog
          editor={editor}
          setEditor={setEditor}
          submit={submit}
          cancel={() => setEditor(null)}
        />
      )}
      {pending && (
        <StepUpDialog
          purpose="samba"
          title={pending.title}
          onCancel={() => setPending(null)}
          onAuthorized={complete}
        />
      )}
    </div>
  );
}
