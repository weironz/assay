import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../stores/auth';
import { useCopQuery } from './api';
import { Failure, panel } from './ui';
export default function CopOverview() {
  const { t } = useTranslation();
  const { has } = useAuth();
  const enabled = has('asset:read') || has('inventory:read');
  const query = useCopQuery<{
    assets: { status: string; _count: { _all: number } }[];
    parts?: number;
    warehouses?: number;
    operations?: number;
    lowStock?: {
      id: string;
      sku: string;
      name: string;
      quantity: number;
      minimumStock: number;
    }[];
  }>('/platform/overview', undefined, enabled);
  if (!enabled) return null;
  return (
    <section className="mb-7">
      <h2 className="mb-3 text-lg font-semibold">
        {t('cop.platformOverview')}
      </h2>
      {query.isError && <Failure error={query.error} retry={query.refetch} />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [
            has('asset:read'),
            'assetCount',
            query.data?.assets.reduce((s, r) => s + r._count._all, 0),
            '/assets',
          ],
          [
            has('inventory:read'),
            'partCount',
            query.data?.parts,
            '/spare-parts',
          ],
          [
            has('inventory:read'),
            'warehouseCount',
            query.data?.warehouses,
            '/inventory?view=warehouses',
          ],
          [
            has('inventory:read'),
            'operationCount',
            query.data?.operations,
            '/inventory',
          ],
        ]
          .filter((r) => r[0])
          .map((r) => (
            <Link key={String(r[1])} to={String(r[3])} className={panel}>
              <p className="text-sm text-gray-500">{t('cop.' + r[1])}</p>
              <p className="mt-2 text-3xl font-semibold">{r[2] ?? '—'}</p>
            </Link>
          ))}
      </div>
      {!!query.data?.lowStock?.length && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <h3 className="mb-2 font-semibold text-amber-700">
            {t('cop.lowStock')}
          </h3>
          <div className="flex flex-wrap gap-3 text-sm">
            {query.data.lowStock.map((p) => (
              <Link
                key={p.id}
                className="underline"
                to={'/spare-parts/' + p.id}
              >
                {p.sku} · {p.name}: {p.quantity} / {p.minimumStock}
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
