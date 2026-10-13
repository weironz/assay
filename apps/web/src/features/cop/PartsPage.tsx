import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { Page, Part, StockOperation, useCopQuery } from './api';
import {
  Activity,
  Field,
  Files,
  Failure,
  PageHeading,
  Pager,
  ResourceForm,
  button,
  input,
  panel,
  secondary,
} from './ui';
const partFields: Field[] = [
  { key: 'sku', required: true },
  { key: 'name', required: true },
  { key: 'category' },
  { key: 'manufacturer' },
  { key: 'model' },
  { key: 'unit', required: true },
  { key: 'minimumStock', type: 'number' },
  { key: 'active', type: 'checkbox' },
  { key: 'description', type: 'textarea' },
];
export default function PartsPage() {
  const { t } = useTranslation();
  const { has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState(''),
    [draft, setDraft] = useState(''),
    [page, setPage] = useState(1),
    [creating, setCreating] = useState(false);
  const parts = useCopQuery<Page<Part>>('/spare-parts', { search, page });
  return (
    <>
      <PageHeading title={t('cop.parts')} hint={t('cop.partsHint')}>
        {has('inventory:manage') && (
          <button className={button} onClick={() => setCreating(true)}>
            {t('cop.newPart')}
          </button>
        )}
      </PageHeading>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft);
          setPage(1);
        }}
      >
        <input
          className={input + ' max-w-sm'}
          aria-label={t('cop.search')}
          placeholder={t('cop.search')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className={secondary}>{t('cop.search')}</button>
      </form>
      {parts.isError && <Failure error={parts.error} retry={parts.refetch} />}
      <div className={panel + ' overflow-x-auto'}>
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              {[
                'sku',
                'name',
                'model',
                'unit',
                'totalStock',
                'minimumStock',
                'status',
              ].map((k) => (
                <th key={k} className="pb-3 pr-4">
                  {t('cop.' + k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {parts.data?.items.map((p) => (
              <tr
                className="border-b border-gray-100 dark:border-gray-800"
                key={p.id}
              >
                <td className="py-3 pr-4">
                  <Link
                    className="text-brand-700 underline"
                    to={'/spare-parts/' + p.id}
                  >
                    {p.sku}
                  </Link>
                </td>
                <td className="pr-4">{p.name}</td>
                <td className="pr-4">{p.model || '—'}</td>
                <td className="pr-4">{p.unit}</td>
                <td
                  className={
                    p.active && p.totalQuantity < p.minimumStock
                      ? 'pr-4 font-semibold text-amber-600'
                      : 'pr-4'
                  }
                >
                  {p.totalQuantity}
                  {p.active && p.totalQuantity < p.minimumStock && (
                    <span className="ml-2 text-xs">{t('cop.lowStock')}</span>
                  )}
                </td>
                <td className="pr-4">{p.minimumStock}</td>
                <td>{t(p.active ? 'cop.active' : 'cop.inactive')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {parts.isLoading && <p className="p-4">{t('cop.loading')}</p>}
        {parts.data?.total === 0 && (
          <p className="p-4 text-gray-400">{t('cop.empty')}</p>
        )}
        <Pager page={page} total={parts.data?.total ?? 0} onChange={setPage} />
      </div>
      {creating && (
        <ResourceForm
          title={t('cop.newPart')}
          fields={partFields}
          initial={{
            active: true,
            unit: t('cop.defaultUnit'),
            minimumStock: 0,
          }}
          onClose={() => setCreating(false)}
          onSave={async (data) => {
            const response = await api.post<Part>('/spare-parts', data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
            navigate('/spare-parts/' + response.data.id);
          }}
        />
      )}
    </>
  );
}
export function PartDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { has } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const part = useCopQuery<Part>('/spare-parts/' + id);
  const ledger = useCopQuery<Page<StockOperation>>('/inventory/operations', {
    sparePartId: id,
    pageSize: 20,
  });
  if (part.isError) return <Failure error={part.error} retry={part.refetch} />;
  if (!part.data) return <p>{t('cop.loading')}</p>;
  const p = part.data;
  return (
    <>
      <Link
        className="mb-4 inline-block text-sm text-brand-700"
        to="/spare-parts"
      >
        ← {t('cop.parts')}
      </Link>
      <PageHeading title={p.name} hint={p.sku}>
        {has('inventory:manage') && (
          <button className={button} onClick={() => setEditing(true)}>
            {t('cop.edit')}
          </button>
        )}
        <Link className={secondary} to={'/inventory?sparePartId=' + id}>
          {t('cop.newOperation')}
        </Link>
      </PageHeading>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className={panel}>
          <dl className="grid grid-cols-2 gap-4">
            {(
              [
                'sku',
                'category',
                'manufacturer',
                'model',
                'unit',
                'minimumStock',
              ] as const
            ).map((k) => (
              <div key={k}>
                <dt className="text-xs text-gray-400">{t('cop.' + k)}</dt>
                <dd className="mt-1 text-sm">{p[k] ?? '—'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-xl font-semibold">
            {t('cop.totalStock')}: {p.totalQuantity} {p.unit}
          </p>
          {p.active && p.totalQuantity < p.minimumStock && (
            <p className="mt-2 text-amber-600">{t('cop.lowStock')}</p>
          )}
          {p.description && (
            <p className="mt-3 text-sm text-gray-500">{p.description}</p>
          )}
          <h2 className="mb-2 mt-6 font-semibold">{t('cop.balances')}</h2>
          {p.balances.map((b) => (
            <div
              className="flex justify-between border-b py-2 text-sm dark:border-gray-800"
              key={b.warehouseId}
            >
              <span>{b.warehouse.name}</span>
              <span>
                {b.quantity} {p.unit}
              </span>
            </div>
          ))}
          {!p.balances.length && (
            <p className="text-sm text-gray-400">{t('cop.empty')}</p>
          )}
        </section>
        <Files kind="spare_part" id={id} canWrite={has('inventory:manage')} />
        <section className={panel}>
          <h2 className="mb-3 font-semibold">{t('cop.operations')}</h2>
          {ledger.isError && <Failure error={ledger.error} />}
          <ul className="space-y-3 text-sm">
            {ledger.data?.items.map((op) => (
              <li key={op.id}>
                <div className="flex justify-between">
                  <span>
                    {t('cop.' + op.type)} · {op.actorName}
                  </span>
                  <span className="text-xs text-gray-400">
                    {op.createdAt.slice(0, 10)}
                  </span>
                </div>
                <p className="text-gray-500">{op.reason}</p>
                {op.movements.map((m) => (
                  <p key={m.id}>
                    {m.warehouse.name}: {m.before} → {m.after} (
                    {m.delta > 0 ? '+' : ''}
                    {m.delta})
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {ledger.data?.total === 0 && (
            <p className="text-sm text-gray-400">{t('cop.empty')}</p>
          )}
          <Link
            className="mt-3 inline-block text-sm text-brand-700 underline"
            to={'/inventory?sparePartId=' + id}
          >
            {t('cop.operations')} →
          </Link>
        </section>
        <Activity kind="spare_part" id={id} />
      </div>
      {editing && (
        <ResourceForm
          title={t('cop.edit') + ' · ' + p.name}
          fields={partFields}
          initial={{ ...p }}
          onClose={() => setEditing(false)}
          onSave={async (data) => {
            await api.put('/spare-parts/' + id, data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
          }}
        />
      )}
    </>
  );
}
