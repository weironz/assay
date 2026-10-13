import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../stores/auth';
import { api } from '../../lib/api';
import {
  Asset,
  Options,
  Page,
  exportCSV,
  useCopCatalogue,
  useCopQuery,
} from './api';
import {
  Activity,
  Files,
  Field,
  Failure,
  PageHeading,
  Pager,
  ResourceForm,
  Status,
  button,
  input,
  panel,
  secondary,
} from './ui';
const states = [
  'PENDING_REGISTRATION',
  'IN_STOCK',
  'IN_USE',
  'MAINTENANCE',
  'RETIRED',
];
export function useAssetFields(options?: Options, asset?: Asset): Field[] {
  const { t } = useTranslation();
  const named = (values: { id: string; name: string }[] = []) =>
    values.map((v) => ({ value: v.id, label: v.name }));
  const status = asset?.status === 'RETIRED' ? ['RETIRED'] : states;
  return [
    ...(asset?.code ? [{ key: 'code', readonly: true }] : []),
    { key: 'name', required: true },
    { key: 'category' },
    { key: 'manufacturer' },
    { key: 'model' },
    { key: 'serialNumber' },
    {
      key: 'status',
      type: 'select',
      required: true,
      options: status.map((v) => ({ value: v, label: t('cop.' + v) })),
    },
    { key: 'custodianId', type: 'select', options: named(options?.users) },
    {
      key: 'departmentId',
      type: 'select',
      options: named(options?.departments.filter((d) => d.active)),
    },
    {
      key: 'datacenterId',
      type: 'select',
      options: named(options?.datacenters),
    },
    { key: 'clusterId', type: 'select', options: named(options?.clusters) },
    { key: 'location' },
    { key: 'rackName' },
    { key: 'rackUnit' },
    { key: 'ownerName' },
    {
      key: 'ownership',
      type: 'select',
      required: true,
      options: ['UNCONFIRMED', 'OWNED', 'LEASED', 'CUSTOMER'].map((v) => ({
        value: v,
        label: t('cop.' + v),
      })),
    },
    { key: 'purchaseDate', type: 'date' },
    { key: 'purchaseCost' },
    { key: 'currency' },
    { key: 'warrantyUntil', type: 'date' },
    { key: 'labelVerified', type: 'checkbox' },
    { key: 'description', type: 'textarea' },
  ];
}
export default function AssetsPage() {
  const { t } = useTranslation();
  const { has } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState(''),
    [draft, setDraft] = useState(''),
    [status, setStatus] = useState(''),
    [page, setPage] = useState(1),
    [creating, setCreating] = useState(false);
  const query = useCopQuery<Page<Asset>>('/assets', {
    search,
    status: status || undefined,
    page,
  });
  const options = useCopQuery<Options>('/platform/options');
  const fields = useAssetFields(options.data);
  const exporting = useMutation({
    mutationFn: () =>
      exportCSV(
        '/assets/export',
        { search, status: status || undefined },
        'greenstor-assets.csv',
      ),
  });
  return (
    <>
      <PageHeading title={t('cop.assets')} hint={t('cop.assetsHint')}>
        {has('asset:manage') && (
          <Link className={secondary} to="/assets/import">
            {t('cop.importAssets')}
          </Link>
        )}
        <button
          className={secondary}
          disabled={exporting.isPending}
          onClick={() => exporting.mutate()}
        >
          {t('cop.export')}
        </button>
        {has('asset:manage') && (
          <button className={button} onClick={() => setCreating(true)}>
            {t('cop.newAsset')}
          </button>
        )}
      </PageHeading>
      <form
        className="mb-4 flex flex-wrap gap-3"
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
        <select
          className={input + ' max-w-48'}
          aria-label={t('cop.status')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('cop.all')}</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {t('cop.' + s)}
            </option>
          ))}
        </select>
        <button className={secondary}>{t('cop.search')}</button>
      </form>
      {query.isError && <Failure error={query.error} retry={query.refetch} />}{' '}
      {exporting.isError && <Failure error={exporting.error} />}
      <div className={panel + ' overflow-x-auto'}>
        <table className="w-full text-left text-sm">
          <thead className="border-b text-gray-500">
            <tr>
              {[
                'code',
                'name',
                'serialNumber',
                'datacenterId',
                'custodianId',
                'status',
              ].map((s) => (
                <th className="pb-3 pr-4" key={s}>
                  {t('cop.' + s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((a) => (
              <tr
                className="border-b border-gray-100 dark:border-gray-800"
                key={a.id}
              >
                <td className="py-3 pr-4">
                  <Link
                    className="font-medium text-brand-700 dark:text-brand-300"
                    to={'/assets/' + a.id}
                  >
                    {a.code || t('cop.awaitingNumber')}
                  </Link>
                </td>
                <td className="pr-4">{a.name}</td>
                <td className="pr-4">{a.serialNumber || '—'}</td>
                <td className="pr-4">{a.datacenter?.name || '—'}</td>
                <td className="pr-4">{a.custodian?.name || '—'}</td>
                <td>
                  <Status value={a.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.isLoading && <p className="p-4">{t('cop.loading')}</p>}
        {query.data?.total === 0 && (
          <p className="p-4 text-gray-400">{t('cop.empty')}</p>
        )}
        <Pager page={page} total={query.data?.total ?? 0} onChange={setPage} />
      </div>
      {creating && (
        <ResourceForm
          title={t('cop.newAsset')}
          hint={t('cop.numberHint')}
          fields={fields}
          initial={{
            status: 'PENDING_REGISTRATION',
            currency: 'CNY',
            ownership: 'UNCONFIRMED',
            labelVerified: false,
          }}
          onClose={() => setCreating(false)}
          onSave={async (data) => {
            const response = await api.post<Asset>('/assets', data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
            navigate('/assets/' + response.data.id);
          }}
        />
      )}
    </>
  );
}
export function AssetDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { has } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false),
    [ticketId, setTicketId] = useState('');
  const asset = useCopQuery<Asset>('/assets/' + id);
  const options = useCopQuery<Options>('/platform/options');
  const fields = useAssetFields(options.data, asset.data);
  const related = useCopQuery<
    { id: string; ticketNo: string; title: string; status: string }[]
  >('/assets/' + id + '/tickets', undefined, has('ticket:read'));
  const tickets = useCopCatalogue<{
    id: string;
    ticketNo: string;
    title: string;
  }>('/tickets', has('asset:manage') && has('ticket:read'));
  const link = useMutation({
    mutationFn: () => api.post('/assets/' + id + '/tickets', { ticketId }),
    onSuccess: () => {
      setTicketId('');
      qc.invalidateQueries({ queryKey: ['cop'] });
    },
  });
  const unlink = useMutation({
    mutationFn: (ticket: string) =>
      api.delete('/assets/' + id + '/tickets/' + ticket),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cop'] }),
  });
  const register = useMutation({
    mutationFn: () => api.post('/assets/' + id + '/register'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cop'] }),
  });
  if (asset.isError)
    return <Failure error={asset.error} retry={asset.refetch} />;
  if (!asset.data) return <p>{t('cop.loading')}</p>;
  const a = asset.data;
  const rows: Record<string, any> = {
    code: a.code || t('cop.awaitingNumber'),
    serialNumber: a.serialNumber,
    category: a.category,
    manufacturer: a.manufacturer,
    model: a.model,
    datacenterId: a.datacenter?.name,
    clusterId: a.cluster?.name,
    rackName: a.rackName,
    rackUnit: a.rackUnit,
    location: a.location,
    departmentId: a.department?.name,
    custodianId: a.custodian?.name,
    ownerName: a.ownerName,
    ownership: t('cop.' + a.ownership),
    purchaseDate: a.purchaseDate?.slice(0, 10),
    purchaseCost: a.purchaseCost,
    currency: a.currency,
    warrantyUntil: a.warrantyUntil?.slice(0, 10),
  };
  return (
    <>
      <Link className="mb-4 inline-block text-sm text-brand-700" to="/assets">
        ← {t('cop.assets')}
      </Link>
      <PageHeading title={a.name} hint={a.code || t('cop.awaitingNumber')}>
        {!a.code && has('asset:manage') && (
          <button
            className={secondary}
            disabled={register.isPending}
            onClick={() => register.mutate()}
          >
            {t('cop.assignNumber')}
          </button>
        )}
        {has('asset:manage') && (
          <button className={button} onClick={() => setEditing(true)}>
            {t('cop.edit')}
          </button>
        )}
      </PageHeading>
      {register.isError && <Failure error={register.error} />}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className={panel}>
          <div className="mb-4 flex gap-2">
            <Status value={a.status} />
            <span className="text-sm text-gray-500">
              {t('cop.labelVerified')}: {a.labelVerified ? '✓' : '—'}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            {Object.entries(rows).map(([key, v]) => (
              <div key={key}>
                <dt className="text-xs text-gray-400">{t('cop.' + key)}</dt>
                <dd className="mt-1 break-words text-sm">{v || '—'}</dd>
              </div>
            ))}
          </dl>
          {a.description && (
            <p className="mt-4 whitespace-pre-wrap text-sm text-gray-500">
              {a.description}
            </p>
          )}
          {a.sourceSystem && (
            <p className="mt-4 border-t pt-3 text-sm text-gray-500">
              {t('cop.source')}: {a.sourceSystem}
              {a.sourceUrl && (
                <a
                  className="ml-3 underline"
                  href={a.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  NetBox ↗
                </a>
              )}
            </p>
          )}
        </section>
        <Files kind="asset" id={id} canWrite={has('asset:manage')} />
        {has('ticket:read') && (
          <section className={panel}>
            <h2 className="mb-3 font-semibold">{t('cop.relatedTickets')}</h2>
            {related.isError && <Failure error={related.error} />}
            <ul className="space-y-2 text-sm">
              {related.data?.map((ticket) => (
                <li
                  key={ticket.id}
                  className="flex items-center justify-between gap-2"
                >
                  <Link
                    className="text-brand-700 underline"
                    to={'/tickets/' + ticket.id}
                  >
                    {ticket.ticketNo} · {ticket.title}
                  </Link>
                  {has('asset:manage') && (
                    <button
                      className={secondary}
                      disabled={unlink.isPending}
                      onClick={() => unlink.mutate(ticket.id)}
                    >
                      {t('cop.unlink')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!related.data?.length && (
              <p className="text-sm text-gray-400">{t('cop.empty')}</p>
            )}
            {has('asset:manage') && (
              <div className="mt-4 flex gap-2">
                <select
                  className={input}
                  aria-label={t('cop.chooseTicket')}
                  value={ticketId}
                  onChange={(e) => setTicketId(e.target.value)}
                >
                  <option value="">{t('cop.chooseTicket')}</option>
                  {tickets.data?.map((ticket) => (
                    <option key={ticket.id} value={ticket.id}>
                      {ticket.ticketNo} · {ticket.title}
                    </option>
                  ))}
                </select>
                <button
                  className={button + ' shrink-0'}
                  disabled={!ticketId || link.isPending}
                  onClick={() => link.mutate()}
                >
                  {t('cop.linkTicket')}
                </button>
              </div>
            )}
            {(link.isError || unlink.isError) && (
              <Failure error={link.error || unlink.error} />
            )}
          </section>
        )}
        <Activity kind="asset" id={id} />
      </div>
      {editing && (
        <ResourceForm
          title={t('cop.edit') + ' · ' + a.name}
          hint={t('cop.labelHint')}
          fields={fields}
          initial={{ ...a }}
          onClose={() => setEditing(false)}
          onSave={async (data) => {
            await api.put('/assets/' + id, data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
          }}
        />
      )}
    </>
  );
}
