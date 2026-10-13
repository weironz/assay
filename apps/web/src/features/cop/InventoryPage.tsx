import { requestId } from './ids';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { inventoryView } from '../../lib/business-navigation';
import {
  Asset,
  Balance,
  Options,
  Page,
  Part,
  StockOperation,
  Warehouse,
  exportCSV,
  useCopCatalogue,
  useCopQuery,
} from './api';
import {
  Failure,
  Field,
  PageHeading,
  Pager,
  ResourceForm,
  button,
  input,
  panel,
  secondary,
} from './ui';
const types = ['RECEIVE', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUST'];
export default function InventoryPage() {
  const { t } = useTranslation();
  const { has } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab = inventoryView(params);
  const rawPage = Number(params.get('page') || 1);
  const page =
    Number.isInteger(rawPage) && rawPage >= 1 && rawPage <= 1000000
      ? rawPage
      : 1;
  const warehouseId = params.get('warehouseId') || '';
  const sparePartId = params.get('sparePartId') || '';
  const updateFilters = (changes: Record<string, string>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('page');
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  };
  const setPage = (value: number) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === 1) next.delete('page');
      else next.set('page', String(value));
      return next;
    });
  const [operationOpen, setOperationOpen] = useState(false),
    [editingWarehouse, setEditingWarehouse] = useState<
      Warehouse | null | undefined
    >(undefined),
    [reverse, setReverse] = useState<StockOperation | null>(null);
  const warehouses = useCopQuery<Warehouse[]>('/warehouses');
  const options = useCopQuery<Options>('/platform/options');
  const parts = useCopCatalogue<Part>('/spare-parts');
  const assets = useCopCatalogue<Asset>('/assets', has('asset:read'));
  const tickets = useCopCatalogue<{
    id: string;
    ticketNo: string;
    title: string;
  }>('/tickets', has('ticket:read'));
  const filter = {
    page,
    warehouseId: warehouseId || undefined,
    sparePartId: sparePartId || undefined,
  };
  const operations = useCopQuery<Page<StockOperation>>(
    '/inventory/operations',
    filter,
    tab === 'operations',
  );
  const balances = useCopQuery<Page<Balance>>(
    '/inventory/balances',
    filter,
    tab === 'balances',
  );
  const exporting = useMutation({
    mutationFn: () =>
      exportCSV('/inventory/export', filter, 'greenstor-stock-ledger.csv'),
  });
  const warehouseFields: Field[] = [
    { key: 'code', label: 'warehouseCode', required: true },
    { key: 'name', required: true },
    { key: 'location' },
    {
      key: 'departmentId',
      type: 'select',
      options: options.data?.departments
        .filter((d) => d.active)
        .map((d) => ({ value: d.id, label: d.name })),
    },
    { key: 'active', type: 'checkbox' },
  ];
  const warehouseOptions =
    warehouses.data
      ?.filter((w) => w.active)
      .map((w) => ({ value: w.id, label: w.code + ' · ' + w.name })) ?? [];
  const stock = operations.data;
  return (
    <>
      <PageHeading
        title={t('cop.' + tab)}
        hint={tab === 'warehouses' ? undefined : t('cop.inventoryHint')}
      >
        {tab !== 'warehouses' && (
          <>
            <button
              className={secondary}
              disabled={exporting.isPending}
              onClick={() => exporting.mutate()}
            >
              {t('cop.export')}
            </button>
            {has('inventory:manage') && (
              <button className={button} onClick={() => setOperationOpen(true)}>
                {t('cop.newOperation')}
              </button>
            )}
          </>
        )}
        {tab === 'warehouses' && has('inventory:manage') && (
          <button className={button} onClick={() => setEditingWarehouse(null)}>
            {t('cop.newWarehouse')}
          </button>
        )}
      </PageHeading>
      {tab !== 'warehouses' && (
        <div className="mb-4 flex flex-wrap gap-3">
          <select
            className={input + ' max-w-xs'}
            aria-label={t('cop.warehouse')}
            value={warehouseId}
            onChange={(e) => {
              updateFilters({ warehouseId: e.target.value });
            }}
          >
            <option value="">
              {t('cop.all')} · {t('cop.warehouse')}
            </option>
            {warehouses.data?.map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select
            className={input + ' max-w-xs'}
            aria-label={t('cop.parts')}
            value={sparePartId}
            onChange={(e) => {
              updateFilters({ sparePartId: e.target.value });
            }}
          >
            <option value="">
              {t('cop.all')} · {t('cop.parts')}
            </option>
            {parts.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {exporting.isError && <Failure error={exporting.error} />}
      {warehouses.isError && (
        <Failure error={warehouses.error} retry={warehouses.refetch} />
      )}
      {tab === 'operations' && (
        <div className={panel + ' overflow-x-auto'}>
          {operations.isError && (
            <Failure error={operations.error} retry={operations.refetch} />
          )}
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  'time',
                  'operationType',
                  'parts',
                  'warehouse',
                  'delta',
                  'before',
                  'after',
                  'actor',
                  'reason',
                ].map((k) => (
                  <th className="pb-3 pr-4 text-gray-500" key={k}>
                    {t('cop.' + k)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {stock?.items.flatMap((op) =>
                op.movements.map((m, index) => (
                  <tr
                    className="border-t border-gray-100 align-top dark:border-gray-800"
                    key={m.id}
                  >
                    <td className="whitespace-nowrap py-3 pr-4">
                      {op.createdAt.slice(0, 10)}
                      <span className="block text-xs text-gray-400">
                        {op.createdAt.slice(11, 16)}
                      </span>
                    </td>
                    <td className="pr-4">
                      {t('cop.' + op.type)}
                      {op.reversedBy && (
                        <span className="block text-xs text-gray-400">
                          {t('cop.REVERSAL')} ✓
                        </span>
                      )}
                    </td>
                    <td className="pr-4">
                      <Link
                        className="text-brand-700 underline"
                        to={'/spare-parts/' + op.sparePart.id}
                      >
                        {op.sparePart.sku}
                      </Link>
                    </td>
                    <td className="pr-4">{m.warehouse.name}</td>
                    <td className="pr-4 tabular-nums">
                      {m.delta > 0 ? '+' : ''}
                      {m.delta}
                    </td>
                    <td className="pr-4 tabular-nums">{m.before}</td>
                    <td className="pr-4 tabular-nums">{m.after}</td>
                    <td className="pr-4">{op.actorName}</td>
                    <td className="min-w-40 pr-4">
                      <p>{op.reason}</p>
                      {op.asset && has('asset:read') && (
                        <Link
                          className="block text-xs text-brand-700"
                          to={'/assets/' + op.asset.id}
                        >
                          {op.asset.code || op.asset.name}
                        </Link>
                      )}
                      {op.ticket && (
                        <Link
                          className="block text-xs text-brand-700"
                          to={'/tickets/' + op.ticket.id}
                        >
                          {op.ticket.ticketNo}
                        </Link>
                      )}
                    </td>
                    <td>
                      {index === 0 &&
                        has('inventory:manage') &&
                        !op.reversedBy &&
                        op.type !== 'REVERSAL' && (
                          <button
                            className={secondary}
                            onClick={() => setReverse(op)}
                          >
                            {t('cop.REVERSAL')}
                          </button>
                        )}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          {stock?.total === 0 && (
            <p className="p-4 text-gray-400">{t('cop.empty')}</p>
          )}
          {operations.isLoading && <p>{t('cop.loading')}</p>}
          <Pager page={page} total={stock?.total ?? 0} onChange={setPage} />
        </div>
      )}
      {tab === 'balances' && (
        <div className={panel}>
          {balances.isError && (
            <Failure error={balances.error} retry={balances.refetch} />
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {['warehouse', 'sku', 'name', 'quantity', 'unit'].map((k) => (
                    <th className="pb-3 pr-4 text-gray-500" key={k}>
                      {t('cop.' + k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {balances.data?.items.map((b) => (
                  <tr
                    className="border-t border-gray-100 dark:border-gray-800"
                    key={b.warehouseId + b.sparePartId}
                  >
                    <td className="py-3 pr-4">{b.warehouse.name}</td>
                    <td className="pr-4">
                      <Link
                        className="text-brand-700 underline"
                        to={'/spare-parts/' + b.sparePartId}
                      >
                        {b.sparePart.sku}
                      </Link>
                    </td>
                    <td className="pr-4">{b.sparePart.name}</td>
                    <td className="pr-4">{b.quantity}</td>
                    <td>{b.sparePart.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {balances.data?.total === 0 && (
            <p className="p-4 text-gray-400">{t('cop.empty')}</p>
          )}
          <Pager
            page={page}
            total={balances.data?.total ?? 0}
            onChange={setPage}
          />
        </div>
      )}
      {tab === 'warehouses' && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {warehouses.data?.map((w) => (
              <section className={panel} key={w.id}>
                <div className="flex justify-between gap-3">
                  <h2 className="font-semibold">{w.name}</h2>
                  {has('inventory:manage') && (
                    <button
                      className={secondary}
                      onClick={() => setEditingWarehouse(w)}
                    >
                      {t('cop.edit')}
                    </button>
                  )}
                </div>
                <p className="mt-2 text-sm text-gray-500">
                  {w.code} · {t(w.active ? 'cop.active' : 'cop.inactive')}
                </p>
                <p className="mt-2 text-sm">{w.location || '—'}</p>
                <button
                  className="mt-3 text-sm text-brand-700 underline"
                  onClick={() => {
                    updateFilters({ warehouseId: w.id, view: 'balances' });
                  }}
                >
                  {t('cop.balances')}
                </button>
              </section>
            ))}
          </div>
          {warehouses.data?.length === 0 && (
            <p className="text-gray-400">{t('cop.empty')}</p>
          )}
        </>
      )}
      {editingWarehouse !== undefined && (
        <ResourceForm
          title={editingWarehouse ? t('cop.edit') : t('cop.newWarehouse')}
          fields={warehouseFields}
          initial={
            editingWarehouse ? { ...editingWarehouse } : { active: true }
          }
          onClose={() => setEditingWarehouse(undefined)}
          onSave={async (data) => {
            if (editingWarehouse)
              await api.put('/warehouses/' + editingWarehouse.id, data);
            else await api.post('/warehouses', data);
            await qc.invalidateQueries({ queryKey: ['cop'] });
          }}
        />
      )}
      {operationOpen && (
        <StockForm
          initialPart={sparePartId}
          warehouses={warehouseOptions}
          parts={parts.data ?? []}
          assets={assets.data ?? []}
          tickets={tickets.data ?? []}
          onClose={() => setOperationOpen(false)}
        />
      )}
      {reverse && (
        <ResourceForm
          title={t('cop.REVERSAL')}
          hint={t('cop.reverseHint')}
          fields={[{ key: 'reason', type: 'textarea', required: true }]}
          initial={{ reason: '' }}
          onClose={() => setReverse(null)}
          onSave={async (data) => {
            await api.post('/inventory/operations', {
              type: 'REVERSAL',
              reversesId: reverse.id,
              reason: data.reason,
              idempotencyKey: requestId(),
            });
            await qc.invalidateQueries({ queryKey: ['cop'] });
          }}
        />
      )}
    </>
  );
}
function StockForm({
  initialPart,
  warehouses,
  parts,
  assets,
  tickets,
  onClose,
}: {
  initialPart: string;
  warehouses: { value: string; label: string }[];
  parts: Part[];
  assets: Asset[];
  tickets: { id: string; ticketNo: string; title: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [type, setType] = useState('RECEIVE');
  const [key, setKey] = useState(requestId());
  const fields: Field[] = [
    {
      key: 'sparePartId',
      label: 'parts',
      type: 'select',
      required: true,
      options: parts
        .filter((p) => p.active)
        .map((p) => ({ value: p.id, label: p.sku + ' · ' + p.name })),
    },
    {
      key: 'warehouseId',
      label: type === 'TRANSFER' ? 'sourceWarehouse' : 'warehouse',
      type: 'select',
      required: true,
      options: warehouses,
    },
    ...(type === 'TRANSFER'
      ? [
          {
            key: 'destinationWarehouseId',
            label: 'destinationWarehouse',
            type: 'select' as const,
            required: true,
            options: warehouses,
          },
        ]
      : []),
    {
      key: 'quantity',
      label: type === 'ADJUST' ? 'countedQuantity' : 'quantity',
      type: 'number',
      required: true,
    },
    { key: 'reason', type: 'textarea', required: true },
    {
      key: 'assetId',
      label: 'assets',
      type: 'select',
      options: assets
        .filter((a) => a.status !== 'RETIRED')
        .map((a) => ({
          value: a.id,
          label: (a.code || a.name) + ' · ' + a.name,
        })),
    },
    {
      key: 'ticketId',
      label: 'relatedTickets',
      type: 'select',
      options: tickets.map((tk) => ({
        value: tk.id,
        label: tk.ticketNo + ' · ' + tk.title,
      })),
    },
  ];
  // Keep the key stable for retries of an identical form; changing the payload gets a new key.
  const [lastPayload, setLastPayload] = useState('');
  return (
    <ResourceForm
      title={t('cop.newOperation')}
      extra={
        <label className="mt-4 block text-sm">
          {t('cop.operationType')}
          <select
            aria-label={t('cop.operationType')}
            className={input + ' mt-1'}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {types.map((v) => (
              <option key={v} value={v}>
                {t('cop.' + v)}
              </option>
            ))}
          </select>
        </label>
      }
      fields={fields}
      initial={{ sparePartId: initialPart, quantity: 1 }}
      onClose={onClose}
      onSave={async (data) => {
        const payload = JSON.stringify({ type, ...data });
        let requestKey = key;
        if (lastPayload && lastPayload !== payload) {
          requestKey = requestId();
          setKey(requestKey);
        }
        setLastPayload(payload);
        await api.post('/inventory/operations', {
          type,
          ...data,
          idempotencyKey: requestKey,
        });
        await qc.invalidateQueries({ queryKey: ['cop'] });
      }}
    />
  );
}
