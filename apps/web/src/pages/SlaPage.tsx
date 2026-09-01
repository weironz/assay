import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTypes, useUpdateType, type TicketType } from '../features/tickets/api';

/**
 * 把分钟数说成人话：90 → 1 小时 30 分钟。
 * 配置项以分钟为单位（够灵活），但光看「2880」没人能一眼反应过来是两天。
 */
function humanize(t: ReturnType<typeof useTranslation>['t'], min: number) {
  if (min < 60) return t('sla.durMinutes', { m: min });
  const h = Math.floor(min / 60);
  const restM = min % 60;
  if (h < 24) {
    return restM ? t('sla.durHoursMinutes', { h, m: restM }) : t('sla.durHours', { h });
  }
  const d = Math.floor(h / 24);
  const restH = h % 24;
  return restH ? t('sla.durDaysHours', { d, h: restH }) : t('sla.durDays', { d });
}

function Row({ type }: { type: TicketType }) {
  const { t } = useTranslation();
  const update = useUpdateType();
  const [editing, setEditing] = useState(false);
  const [resp, setResp] = useState(String(type.slaResponseMin));
  const [reso, setReso] = useState(String(type.slaResolveMin));
  const [err, setErr] = useState<string | null>(null);

  const start = () => {
    setResp(String(type.slaResponseMin));
    setReso(String(type.slaResolveMin));
    setErr(null);
    setEditing(true);
  };

  const save = () => {
    const a = Number(resp);
    const b = Number(reso);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
      setErr(t('slaAdmin.errPositive'));
      return;
    }
    // 响应时限比解决时限还长是配置错误，拦下来比事后查报表省事
    if (a > b) {
      setErr(t('slaAdmin.errResponseGreater'));
      return;
    }
    update.mutate(
      { id: type.id, slaResponseMin: a, slaResolveMin: b },
      {
        // 成功后要清掉上一次的校验提示，否则改对了红字还挂在那里
        onSuccess: () => {
          setErr(null);
          setEditing(false);
        },
        onError: () => setErr(t('slaAdmin.errSave')),
      },
    );
  };

  const inputCls =
    'w-24 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800';

  return (
    <tr className="border-t border-gray-100 dark:border-gray-800">
      <td className="px-4 py-3 font-medium">{type.name}</td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            value={resp}
            onChange={(e) => setResp(e.target.value)}
            className={inputCls}
            inputMode="numeric"
            aria-label={t('slaAdmin.colResponse')}
          />
        ) : (
          <span>
            {humanize(t, type.slaResponseMin)}
            <span className="ml-2 text-xs text-gray-400">
              {t('slaAdmin.minutes', { n: type.slaResponseMin })}
            </span>
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {editing ? (
          <input
            value={reso}
            onChange={(e) => setReso(e.target.value)}
            className={inputCls}
            inputMode="numeric"
            aria-label={t('slaAdmin.colResolve')}
          />
        ) : (
          <span>
            {humanize(t, type.slaResolveMin)}
            <span className="ml-2 text-xs text-gray-400">
              {t('slaAdmin.minutes', { n: type.slaResolveMin })}
            </span>
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        {editing ? (
          <span className="flex items-center justify-end gap-2">
            <button
              onClick={() => setEditing(false)}
              className="rounded-md border border-gray-300 px-3 py-1 text-xs dark:border-gray-700"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              disabled={update.isPending}
              className="rounded-md bg-brand-700 px-3 py-1 text-xs text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {t('common.save')}
            </button>
          </span>
        ) : (
          <button onClick={start} className="text-xs text-brand-700 hover:underline">
            {t('common.edit')}
          </button>
        )}
        {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
      </td>
    </tr>
  );
}

export default function SlaPage() {
  const { t } = useTranslation();
  const { data: types, isLoading } = useTypes();

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('slaAdmin.title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('slaAdmin.intro')}</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-gray-50 text-gray-500 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-2 text-left font-medium">{t('slaAdmin.colType')}</th>
              <th className="px-4 py-2 text-left font-medium">{t('slaAdmin.colResponse')}</th>
              <th className="px-4 py-2 text-left font-medium">{t('slaAdmin.colResolve')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {types?.map((ty) => <Row key={ty.id} type={ty} />)}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900">
        <p className="mb-2 font-medium text-gray-700 dark:text-gray-300">
          {t('slaAdmin.rulesTitle')}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>{t('slaAdmin.ruleStart')}</li>
          <li>{t('slaAdmin.ruleHold')}</li>
          <li>{t('slaAdmin.ruleBreach')}</li>
          <li>{t('slaAdmin.ruleScope')}</li>
        </ul>
      </div>
    </div>
  );
}
