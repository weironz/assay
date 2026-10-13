import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { Asset, useCopCatalogue, useCopQuery } from './api';
import { Failure, button, input, panel, secondary } from './ui';
export default function TicketAssets({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation();
  const { has } = useAuth();
  const qc = useQueryClient();
  const [assetId, setAssetId] = useState('');
  const related = useCopQuery<Pick<Asset, 'id' | 'code' | 'name' | 'status'>[]>(
    '/tickets/' + ticketId + '/assets',
  );
  const options = useCopCatalogue<Asset>('/assets', has('asset:manage'));
  const link = useMutation({
    mutationFn: () => api.post('/assets/' + assetId + '/tickets', { ticketId }),
    onSuccess: () => {
      setAssetId('');
      qc.invalidateQueries({ queryKey: ['cop'] });
    },
  });
  const unlink = useMutation({
    mutationFn: (id: string) =>
      api.delete('/assets/' + id + '/tickets/' + ticketId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cop'] }),
  });
  return (
    <section className={panel}>
      <h2 className="mb-3 font-semibold">{t('cop.assets')}</h2>
      {related.isError && <Failure error={related.error} />}
      <ul className="space-y-2 text-sm">
        {related.data?.map((asset) => (
          <li
            className="flex items-center justify-between gap-2"
            key={asset.id}
          >
            {has('asset:read') ? (
              <Link
                className="text-brand-700 underline"
                to={'/assets/' + asset.id}
              >
                {asset.code || asset.name} · {asset.name}
              </Link>
            ) : (
              <span>
                {asset.code || asset.name} · {asset.name}
              </span>
            )}
            {has('asset:manage') && (
              <button
                className={secondary}
                disabled={unlink.isPending}
                onClick={() => unlink.mutate(asset.id)}
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
        <div className="mt-3 flex gap-2">
          <select
            className={input}
            aria-label={t('cop.assets')}
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          >
            <option value="">{t('cop.optional')}</option>
            {options.data
              ?.filter((a) => !related.data?.some((r) => r.id === a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code || a.name} · {a.name}
                </option>
              ))}
          </select>
          <button
            className={button}
            disabled={!assetId || link.isPending}
            onClick={() => link.mutate()}
          >
            {t('cop.linkTicket')}
          </button>
        </div>
      )}
      {(link.isError || unlink.isError || options.isError) && (
        <Failure error={link.error || unlink.error || options.error} />
      )}
    </section>
  );
}
