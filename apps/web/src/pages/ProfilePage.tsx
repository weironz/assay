import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, absUrl } from '../lib/api';
import { authClient, signOut } from '../lib/auth-client';
import { useAuth } from '../stores/auth';
import { type Msg, useMsg } from '../lib/messages';

const inputCls =
  'w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm';
const card =
  'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 space-y-3';

export default function ProfilePage() {
  const { t } = useTranslation();
  const showMsg = useMsg();
  const navigate = useNavigate();
  const { user, fetchMe, clear } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(user?.name ?? '');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  // 修改密码
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwdMsg, setPwdMsg] = useState<Msg>(null);
  // 密码提示是成功还是失败，用于着色——不能再靠匹配「成功」二字
  const [pwdOk, setPwdOk] = useState(false);

  // 删除账号
  const [delPwd, setDelPwd] = useState('');
  const [delMsg, setDelMsg] = useState<Msg>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  if (!user) return <div className="text-gray-400">{t('common.loading')}</div>;

  const initial = (user.name || user.email).slice(0, 1).toUpperCase();

  const uploadAvatar = async (file?: File | null) => {
    if (!file) return;
    setMsg(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/me/avatar', fd);
      const res = await authClient.updateUser({ image: data.url });
      if (res.error) throw new Error(res.error.message);
      await fetchMe();
      setMsg({ key: 'profile.avatarUpdated' });
    } catch (e: any) {
      const raw = e?.response?.data?.message || e?.message;
      setMsg(raw ? { raw } : { key: 'profile.errAvatarFailed' });
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!name.trim()) return setMsg({ key: 'profile.errNameRequired' });
    setBusy(true);
    try {
      const res = await authClient.updateUser({ name: name.trim() });
      if (res.error) throw new Error(res.error.message);
      await fetchMe();
      setMsg({ key: 'profile.saved' });
    } catch (e: any) {
      setMsg(e?.message ? { raw: e.message } : { key: 'profile.errSaveFailed' });
    } finally {
      setBusy(false);
    }
  };

  const changePwd = async (e: FormEvent) => {
    e.preventDefault();
    setPwdMsg(null);
    setPwdOk(false);
    if (next.length < 6)
      return setPwdMsg({ key: 'profile.errPasswordTooShort' });
    if (next !== confirm) return setPwdMsg({ key: 'profile.errPasswordMismatch' });
    setBusy(true);
    try {
      const res = await authClient.changePassword({
        currentPassword: cur,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (res.error) {
        setPwdMsg(
          res.error.message
            ? { raw: res.error.message }
            : { key: 'profile.errWrongPassword' },
        );
        return;
      }
      setCur('');
      setNext('');
      setConfirm('');
      setPwdOk(true);
      setPwdMsg({ key: 'profile.passwordChanged' });
    } catch (e: any) {
      setPwdMsg(
        e?.message ? { raw: e.message } : { key: 'profile.errChangeFailed' },
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setDelMsg(null);
    setBusy(true);
    try {
      const res = await authClient.deleteUser({ password: delPwd });
      if (res.error) {
        setDelMsg(
          res.error.message
            ? { raw: res.error.message }
            : { key: 'profile.errDeleteFailed' },
        );
        return;
      }
      await signOut().catch(() => {});
      clear();
      navigate('/login', { replace: true });
    } catch (e: any) {
      setDelMsg(
        e?.message ? { raw: e.message } : { key: 'profile.errDeleteFailed' },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">{t('profile.title')}</h1>

      {/* 头像与基本资料 */}
      <div className={card}>
        <h2 className="text-sm font-medium text-gray-500">
          {t('profile.avatarSection')}
        </h2>
        <div className="flex items-center gap-4">
          {user.image ? (
            <img
              src={absUrl(user.image)}
              alt={t('profile.avatarAlt')}
              className="w-16 h-16 rounded-full object-cover border border-gray-200 dark:border-gray-700"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-brand-700 text-white flex items-center justify-center text-xl font-medium">
              {initial}
            </div>
          )}
          <div>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {t('profile.changeAvatar')}
            </button>
            <p className="text-xs text-gray-400 mt-1">
              {t('profile.avatarHint')}
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
            <label className="block text-sm text-gray-500 mb-1">
              {t('profile.nameLabel')}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="text-sm text-gray-500">
            {t('profile.emailLabel')}{' '}
            <span className="text-gray-700 dark:text-gray-300">
              {user.email}
            </span>
            {user.emailVerified ? (
              <span className="ml-2 text-green-600 text-xs">
                {t('profile.verified')}
              </span>
            ) : (
              <span className="ml-2 text-amber-600 text-xs">
                {t('profile.unverified')}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-500">
            {t('profile.rolesLabel')}{' '}
            <span className="text-gray-700 dark:text-gray-300">
              {user.roles.join(', ')}
            </span>
          </div>
          {msg && <p className="text-sm text-green-600">{showMsg(msg)}</p>}
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
          >
            {t('profile.saveProfile')}
          </button>
        </form>
      </div>

      {/* 修改密码 */}
      <form onSubmit={changePwd} className={card}>
        <h2 className="text-sm font-medium text-gray-500">
          {t('profile.changePassword')}
        </h2>
        <input
          type="password"
          placeholder={t('profile.currentPassword')}
          aria-label={t('profile.currentPassword')}
          required
          value={cur}
          onChange={(e) => setCur(e.target.value)}
          className={inputCls}
          autoComplete="current-password"
        />
        <input
          type="password"
          placeholder={t('profile.newPassword')}
          aria-label={t('profile.newPassword')}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={inputCls}
          autoComplete="new-password"
        />
        <input
          type="password"
          placeholder={t('profile.confirmPassword')}
          aria-label={t('profile.confirmPassword')}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputCls}
          autoComplete="new-password"
        />
        {pwdMsg && (
          <p className={`text-sm ${pwdOk ? 'text-green-600' : 'text-red-500'}`}>
            {showMsg(pwdMsg)}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-brand-700 text-white px-4 py-2 text-sm hover:bg-brand-800 disabled:opacity-60"
        >
          {t('profile.confirmChange')}
        </button>
      </form>

      {/* 危险操作 */}
      <div className="bg-white dark:bg-gray-900 border border-red-200 dark:border-red-900 rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-medium text-red-600">
          {t('profile.deleteAccount')}
        </h2>
        <p className="text-sm text-gray-500">
          {t('profile.deleteWarning')}
          <br />
          {t('profile.deleteWarning2')}
        </p>
        {!confirmDel ? (
          <button
            onClick={() => setConfirmDel(true)}
            className="rounded-md border border-red-500 text-red-600 px-4 py-2 text-sm hover:bg-red-50 dark:hover:bg-red-950"
          >
            {t('profile.deleteStart')}
          </button>
        ) : (
          <div className="space-y-3">
            <input
              type="password"
              placeholder={t('profile.deletePasswordPlaceholder')}
              aria-label={t('profile.deletePasswordPlaceholder')}
              value={delPwd}
              onChange={(e) => setDelPwd(e.target.value)}
              className={inputCls}
            />
            {delMsg && <p className="text-sm text-red-500">{showMsg(delMsg)}</p>}
            <div className="flex gap-2">
              <button
                onClick={deleteAccount}
                disabled={busy || !delPwd}
                className="rounded-md bg-red-600 text-white px-4 py-2 text-sm hover:bg-red-700 disabled:opacity-60"
              >
                {t('profile.deleteConfirm')}
              </button>
              <button
                onClick={() => {
                  setConfirmDel(false);
                  setDelPwd('');
                  setDelMsg(null);
                }}
                className="rounded-md border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
