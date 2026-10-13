import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import CopOverview from '../features/cop/Overview';
import { BUSINESS_MODULES, allowedItems } from '../lib/business-navigation';
import { useAuth } from '../stores/auth';

export default function PlatformOverviewPage() {
  const { t } = useTranslation();
  const { has } = useAuth();
  const modules = BUSINESS_MODULES.map((module) => ({
    ...module,
    items: allowedItems(module.items, has),
  })).filter((module) => module.items.length > 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t('nav.platformOverview')}</h1>
      <section>
        <h2 className="mb-3 text-lg font-semibold">
          {t('nav.businessModules')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {modules.map((module) => (
            <Link
              key={module.id}
              to={module.items[0].to}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-5 font-medium transition hover:border-brand-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-brand-800"
            >
              {t(module.labelKey)}
              <span aria-hidden className="text-gray-400">→</span>
            </Link>
          ))}
        </div>
      </section>
      <CopOverview />
    </div>
  );
}
