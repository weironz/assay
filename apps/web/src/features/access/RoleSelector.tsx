import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { filterRoles, type AssignableRole } from './role-selection';

interface Props {
  roles: AssignableRole[];
  selected: string[];
  onToggle: (name: string) => void;
  disabled?: boolean;
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
}

export default function RoleSelector({ roles, selected, onToggle, disabled, loading, failed, onRetry }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const label = (role: AssignableRole) => t(`access.roles.${role.name}`, { defaultValue: role.description || role.name });
  const summary = (role: AssignableRole) => t(`access.summaries.${role.name}`, { defaultValue: role.description || role.name });
  const visible = filterRoles(roles, query, selected, selectedOnly, role => `${label(role)} ${summary(role)}`);
  const clear = () => { setQuery(''); setSelectedOnly(false); };

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <h3 id={`${id}-title`} className="text-sm font-semibold">{t('access.title')}</h3>
        <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-400">{t('access.hint')}</p>
      </div>
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 p-3 dark:border-gray-700">
            <label className="relative min-w-0 flex-1 basis-60">
              <span className="sr-only">{t('access.search')}</span>
              <svg aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
              <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('access.search')}
                onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
                disabled={disabled} className="min-h-11 w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-950" />
            </label>
            <div className="flex shrink-0 rounded-md bg-gray-100 p-1 text-xs dark:bg-gray-800" role="group" aria-label={t('access.title')}>
              {[false, true].map(only => <button key={String(only)} type="button" disabled={disabled} aria-pressed={selectedOnly === only}
                onClick={() => setSelectedOnly(only)} className={`min-h-9 rounded px-3 ${selectedOnly === only ? 'bg-white font-medium text-brand-800 shadow-sm dark:bg-gray-700 dark:text-brand-300' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}`}>
                {t(only ? 'access.selected' : 'access.all')}{only && ` (${selected.length})`}
              </button>)}
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto overscroll-contain" aria-busy={loading}>
            {loading ? <p role="status" className="p-8 text-center text-sm text-gray-500">{t('access.loading')}</p> : failed ?
              <div role="alert" className="p-8 text-center text-sm"><p>{t('access.failed')}</p><button type="button" onClick={onRetry} className="mt-2 min-h-11 px-3 text-brand-700 dark:text-brand-300">{t('access.retry')}</button></div> :
              <table className="w-full table-fixed text-left text-sm">
                <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300"><tr>
                  <th scope="col" className="w-[43%] px-4 py-2.5 font-medium">{t('access.role')}</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">{t('access.scope')}</th>
                </tr></thead>
                <tbody>{visible.map(role => {
                  const checked = selected.includes(role.name);
                  return <tr key={role.id} className={`border-t border-gray-100 align-top dark:border-gray-800 ${checked ? 'bg-brand-50/60 dark:bg-brand-950/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                    <td className="px-4 py-3">
                      <label className="flex min-h-11 cursor-pointer items-start gap-3">
                        <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(role.name)} className="mt-1 h-4 w-4 shrink-0" />
                        <span className="min-w-0"><span className="block break-words font-medium">{label(role)}</span>
                          <code className="mt-1 block break-all text-xs text-gray-500 dark:text-gray-400">{role.name}</code>
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-xs leading-5 text-gray-600 dark:text-gray-300">{summary(role)}</p>
                      {role.name === 'admin' && <span className="mt-1 inline-block text-xs font-medium text-amber-800 dark:text-amber-300">{t('access.admin')}</span>}
                      {role.permissions && <details className="mt-1.5 text-xs">
                        <summary className="cursor-pointer py-1 text-brand-700 dark:text-brand-300">{t('access.permissionCount', { count: role.permissions.length })}</summary>
                        <ul aria-label={t('access.permissions')} className="mt-1 space-y-1 border-l border-gray-300 pl-3 dark:border-gray-600">
                          {role.permissions.map(code => <li key={code}><code className="break-all text-gray-600 dark:text-gray-300">{code}</code></li>)}
                        </ul>
                      </details>}
                    </td>
                  </tr>;
                })}</tbody>
              </table>}
            {!loading && !failed && !visible.length && <div className="px-4 py-8 text-center text-sm">
              <p className="font-medium">{t('access.noResults')}</p><p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('access.noResultsHint')}</p>
              <button type="button" disabled={disabled} onClick={clear} className="mt-2 min-h-11 px-3 text-brand-700 dark:text-brand-300">{t('access.clear')}</button>
            </div>}
          </div>
          <p role="status" className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">{t('access.results', { count: visible.length })}</p>
        </div>
        <aside aria-label={t('access.selected')} className="min-w-0 border-t border-gray-200 bg-gray-50/70 p-4 lg:border-l lg:border-t-0 dark:border-gray-700 dark:bg-gray-950/50">
          <p aria-live="polite" className="text-sm font-semibold">{t('access.count', { count: selected.length })}</p>
          {selected.length ? <ul className="mt-3 max-h-52 space-y-2 overflow-y-auto">
            {selected.map(name => { const role = roles.find(item => item.name === name); const title = role ? label(role) : name;
              return <li key={name} className="flex items-center justify-between gap-2 rounded-md border border-gray-200 bg-white pl-3 text-xs dark:border-gray-700 dark:bg-gray-900">
                <span className="min-w-0 break-words py-2">{title}</span>
                <button type="button" disabled={disabled} onClick={() => onToggle(name)} aria-label={t('access.remove', { name: title })} className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-r-md text-gray-500 hover:bg-gray-100 hover:text-red-700 dark:hover:bg-gray-800 dark:hover:text-red-400">
                  <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 4 8 8M12 4l-8 8" /></svg>
                </button>
              </li>;
            })}
          </ul> : <div className="py-5"><p className="text-sm text-gray-600 dark:text-gray-300">{t('access.none')}</p><p className="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{t('access.noneHint')}</p></div>}
          {selected.includes('admin') && <p className="mt-4 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-amber-800 dark:text-amber-300">{t('access.adminHint')}</p>}
        </aside>
      </div>
    </section>
  );
}
