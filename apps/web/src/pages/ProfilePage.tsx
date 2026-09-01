import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, absUrl } from '../lib/api';
import { authClient, signOut } from '../lib/auth-client';
import { useAuth } from '../stores/auth';

const inputCls =
  'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';
const card =
  'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 space-y-3';

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, fetchMe, clear } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(user?.name ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // 修改密码
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');

  // 删除账号
  const [delPwd, setDelPwd] = useState('');
  const [delMsg, setDelMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  if (!user) return <div className="text-gray-400">加载中…</div>;

  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  const uploadAvatar = async (file?: File | null) => {
    if (!file) return;
    setMsg('');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/me/avatar', fd);
      const res = await authClient.updateUser({ image: data.url });
      if (res.error) throw new Error(res.error.message);
      await fetchMe();
      setMsg('头像已更新');
    } catch (e: any) {
      setMsg(e?.response?.data?.message || e?.message || '头像上传失败');
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    if (!name.trim()) return setMsg('姓名不能为空');
    setBusy(true);
    try {
      const res = await authClient.updateUser({ name: name.trim() });
      if (res.error) throw new Error(res.error.message);
      await fetchMe();
      setMsg('资料已保存');
    } catch (e: any) {
      setMsg(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const changePwd = async (e: FormEvent) => {
    e.preventDefault();
    setPwdMsg('');
    if (next.length < 6) return setPwdMsg('新密码至少 6 位');
    if (next !== confirm) return setPwdMsg('两次输入的新密码不一致');
    setBusy(true);
    try {
      const res = await authClient.changePassword({
        currentPassword: cur,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (res.error) {
        setPwdMsg(res.error.message || '修改失败（原密码可能不正确）');
        return;
      }
      setCur('');
      setNext('');
      setConfirm('');
      setPwdMsg('密码修改成功，其他设备的登录已失效');
    } catch (e: any) {
      setPwdMsg(e?.message || '修改失败');
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setDelMsg('');
    setBusy(true);
    try {
      const res = await authClient.deleteUser({ password: delPwd });
      if (res.error) {
        setDelMsg(res.error.message || '删除失败');
        return;
      }
      await signOut().catch(() => {});
      clear();
      navigate('/login', { replace: true });
    } catch (e: any) {
      setDelMsg(e?.message || '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">个人中心</h1>

      {/* 头像与基本资料 */}
      <div className={card}>
        <h2 className="text-sm font-medium text-gray-500">头像与资料</h2>
        <div className="flex items-center gap-4">
          {user.image ? (
            <img
              src={absUrl(user.image)}
              alt="头像"
              className="w-16 h-16 rounded-full object-cover border border-gray-200 dark:border-gray-700"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-blue-600 text-white flex items-center justify-center text-xl font-medium">
              {initial}
            </div>
          )}
          <div>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              更换头像
            </button>
            <p className="text-xs text-gray-400 mt-1">
              支持 PNG / JPG / GIF / WEBP，不超过 2MB
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => uploadAvatar(e.target.files?.[0])}
            />
          </div>
        </div>

        <form onSubmit={saveName} className="space-y-3 pt-2">
          <div>
            <label className="block text-sm text-gray-500 mb-1">姓名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="text-sm text-gray-500">
            邮箱：<span className="text-gray-700 dark:text-gray-300">{user.email}</span>
            {user.emailVerified ? (
              <span className="ml-2 text-green-600 text-xs">已验证</span>
            ) : (
              <span className="ml-2 text-amber-600 text-xs">未验证</span>
            )}
          </div>
          <div className="text-sm text-gray-500">
            角色：
            <span className="text-gray-700 dark:text-gray-300">
              {user.roles.join('、')}
            </span>
          </div>
          {msg && <p className="text-sm text-green-600">{msg}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
          >
            保存资料
          </button>
        </form>
      </div>

      {/* 修改密码 */}
      <form onSubmit={changePwd} className={card}>
        <h2 className="text-sm font-medium text-gray-500">修改密码</h2>
        <input
          type="password"
          placeholder="当前密码"
          required
          value={cur}
          onChange={(e) => setCur(e.target.value)}
          className={inputCls}
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder="新密码（≥6 位）"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={inputCls}
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder="确认新密码"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputCls}
          autoComplete="new-password"
        />
        {pwdMsg && (
          <p
            className={`text-sm ${pwdMsg.includes('成功') ? 'text-green-600' : 'text-red-500'}`}
          >
            {pwdMsg}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
        >
          确认修改
        </button>
      </form>

      {/* 危险操作 */}
      <div className="bg-white dark:bg-gray-900 border border-red-200 dark:border-red-900 rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-medium text-red-600">删除账号</h2>
        <p className="text-sm text-gray-500">
          删除后账号与登录凭据将被永久移除，不可恢复。
          <br />
          注意：若账号已有工单或回复记录，出于审计要求无法删除，请联系管理员禁用。
        </p>
        {!confirmDel ? (
          <button
            onClick={() => setConfirmDel(true)}
            className="rounded-md border border-red-500 text-red-600 px-4 py-2 text-sm hover:bg-red-50 dark:hover:bg-red-950"
          >
            我要删除账号
          </button>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              placeholder="输入当前密码以确认"
              value={delPwd}
              onChange={(e) => setDelPwd(e.target.value)}
              className={inputCls}
            />
            {delMsg && <p className="text-sm text-red-500">{delMsg}</p>}
            <div className="flex gap-2">
              <button
                onClick={deleteAccount}
                disabled={busy || !delPwd}
                className="rounded-md bg-red-600 text-white px-4 py-2 text-sm hover:bg-red-700 disabled:opacity-60"
              >
                确认永久删除
              </button>
              <button
                onClick={() => {
                  setConfirmDel(false);
                  setDelPwd('');
                  setDelMsg('');
                }}
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
