import { requestId } from './ids';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import {
  ImportRow,
  ImportSheet,
  mapImportRows,
  readImportFile,
} from './import';
import { Failure, PageHeading, button, input, panel, secondary } from './ui';
type Preview = {
  fingerprint: string;
  created: number;
  updated: number;
  errors: number;
  items: {
    index: number;
    name: string;
    site: string;
    code: string | null;
    action: string;
    warnings: string[];
    errors: string[];
  }[];
};
export default function AssetImportPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sheets, setSheets] = useState<ImportSheet[]>([]),
    [sheetIndex, setSheetIndex] = useState(0),
    [rows, setRows] = useState<ImportRow[]>([]),
    [preview, setPreview] = useState<Preview | null>(null),
    [key, setKey] = useState(requestId());
  const file = useMutation({
    mutationFn: async (f: File) => {
      setRows([]);
      setPreview(null);
      commit.reset();
      const parsed = await readImportFile(f);
      setSheets(parsed);
      setSheetIndex(0);
      setRows(await mapImportRows(parsed[0].rows));
      setPreview(null);
      setKey(requestId());
    },
  });
  const sheet = useMutation({
    mutationFn: async (index: number) => {
      setPreview(null);
      setRows([]);
      commit.reset();
      setSheetIndex(index);
      setRows(await mapImportRows(sheets[index].rows));
      setPreview(null);
      setKey(requestId());
    },
  });
  const netbox = useMutation({
    mutationFn: async () => {
      setPreview(null);
      setRows([]);
      commit.reset();
      const response = await api.get<{ rows: ImportRow[] }>(
        '/assets/import/netbox',
      );
      setRows(response.data.rows);
      setSheets([]);
      setPreview(null);
      setKey(requestId());
    },
  });
  const inspect = useMutation({
    mutationFn: async () => {
      const response = await api.post<Preview>('/assets/import/preview', {
        rows,
      });
      setPreview(response.data);
    },
  });
  const commit = useMutation({
    mutationFn: async () => {
      const response = await api.post<{ created: number; updated: number }>(
        '/assets/import/commit',
        { rows, fingerprint: preview?.fingerprint, idempotencyKey: key },
      );
      await qc.invalidateQueries({ queryKey: ['cop'] });
      return response.data;
    },
  });
  const busy =
    file.isPending ||
    sheet.isPending ||
    inspect.isPending ||
    commit.isPending ||
    netbox.isPending;
  return (
    <>
      <Link className="mb-4 inline-block text-sm text-brand-700" to="/assets">
        ← {t('cop.assets')}
      </Link>
      <PageHeading title={t('cop.importAssets')} hint={t('cop.importHint')} />
      <section className={panel}>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            {t('cop.chooseFile')}
            <input
              type="file"
              className="mt-2 block max-w-full"
              accept=".xlsx,.csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) file.mutate(f);
                e.target.value = '';
              }}
            />
          </label>
          <button
            className={secondary}
            disabled={busy}
            onClick={() => netbox.mutate()}
          >
            {t('cop.netbox')}
          </button>
          {sheets.length > 1 && (
            <label className="text-sm">
              {t('cop.worksheet')}
              <select
                className={input}
                value={sheetIndex}
                disabled={busy}
                onChange={(e) => sheet.mutate(Number(e.target.value))}
              >
                {sheets.map((s, i) => (
                  <option key={i} value={i}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className={button}
            disabled={!rows.length || busy}
            onClick={() => {
              commit.reset();
              inspect.mutate();
            }}
          >
            {t('cop.preview')}
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          {t('cop.fileLimit')} {rows.length > 0 && '· ' + rows.length}
        </p>
        {[file, sheet, netbox, inspect, commit]
          .filter((m) => m.isError)
          .map((m, i) => (
            <Failure key={i} error={m.error} />
          ))}
      </section>
      {preview && (
        <section className={panel + ' mt-5'}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {t('cop.newRecords')}: {preview.created} ·{' '}
              {t('cop.updatedRecords')}: {preview.updated} · {t('cop.warnings')}
              :{' '}
              {
                preview.items.filter(
                  (i) => i.warnings.length || i.errors.length,
                ).length
              }
            </p>
            <button
              className={button}
              disabled={!!preview.errors || busy || commit.isSuccess}
              onClick={() => commit.mutate()}
            >
              {t('cop.commitImport')}
            </button>
          </div>
          {commit.isSuccess && (
            <p
              role="status"
              className="mb-4 rounded-md bg-green-50 p-3 text-green-800 dark:bg-green-950 dark:text-green-300"
            >
              {t('cop.saved')} · {t('cop.newRecords')}: {commit.data.created} ·{' '}
              {t('cop.updatedRecords')}: {commit.data.updated}
            </p>
          )}
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {['name', 'datacenterId', 'code', 'warnings'].map((k) => (
                    <th key={k} className="pb-3 pr-4 text-gray-500">
                      {t('cop.' + k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr
                    className="border-t dark:border-gray-800"
                    key={item.index}
                  >
                    <td className="py-3 pr-4">{item.name}</td>
                    <td className="pr-4">{item.site}</td>
                    <td className="pr-4">
                      {item.code || t('cop.awaitingNumber')}
                    </td>
                    <td>
                      <span
                        className={
                          item.errors.length ? 'text-red-600' : 'text-amber-600'
                        }
                      >
                        {[...item.errors, ...item.warnings].join(' · ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
