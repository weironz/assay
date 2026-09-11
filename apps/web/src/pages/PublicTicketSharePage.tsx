import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { usePublicTicketShare } from '../features/tickets/api';
import { PRIORITY_COLOR, STATUS_COLOR, priorityLabel, statusLabel } from '../lib/ticket-meta';
import { renderHtml } from '../lib/sanitize';
import { useDateFormat } from '../i18n/format';
import { apiOrigin } from '../lib/api';

function Meta({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-gray-800 dark:text-gray-200">{value}</dd>
    </div>
  );
}

/**
 * 生产同域时保留 /api/...；开发环境 Web(5173) 与 API(3000) 分端口，
 * 因此把分享正文生成的相对图片地址补成 API 源站绝对地址。
 */
function publicBody(body: string) {
  if (!apiOrigin) return body;
  return body.replace(
    /(["'])\/api\/shared-tickets\//g,
    `$1${apiOrigin}/api/shared-tickets/`,
  );
}

export default function PublicTicketSharePage() {
  const { t } = useTranslation();
  const fmt = useDateFormat();
  const { token = '' } = useParams();
  const { data: ticket, isLoading, isError } = usePublicTicketShare(token);

  return (
    <main className="min-h-dvh bg-gray-50 px-4 py-5 text-gray-900 dark:bg-gray-950 dark:text-gray-100 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img
              src="/brand/greenstor-lockup.png"
              alt="Greenstor"
              className="h-auto w-[106px] dark:hidden"
            />
            <img
              src="/brand/greenstor-lockup-dark.png"
              alt="Greenstor"
              className="hidden h-auto w-[106px] dark:block"
            />
            <span aria-hidden className="h-4 w-px bg-gray-300 dark:bg-gray-700" />
            <span className="text-xs tracking-wide text-gray-500 dark:text-gray-400">
              {t('share.publicBrand')}
            </span>
          </div>
          <LanguageSwitcher />
        </header>

        {isLoading && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500 shadow-sm dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            {t('common.loading')}
          </div>
        )}

        {isError && (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h1 className="text-lg font-semibold">{t('share.unavailableTitle')}</h1>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">
              {t('share.unavailableHint')}
            </p>
          </div>
        )}

        {ticket && (
          <div className="space-y-4">
            <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-gray-400">{ticket.ticketNo}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[ticket.status]}`}>
                  {statusLabel(t, ticket.status)}
                </span>
                <span className={`text-xs ${PRIORITY_COLOR[ticket.priority]}`}>
                  {priorityLabel(t, ticket.priority)}
                </span>
                <span className="ml-auto rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  {t('share.readOnly')}
                </span>
              </div>
              <h1 className="mt-3 break-words text-xl font-semibold leading-8 sm:text-2xl">{ticket.title}</h1>
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-gray-100 pt-4 dark:border-gray-800 sm:grid-cols-4">
                <Meta label={t('share.metaType')} value={ticket.type?.name} />
                <Meta label={t('share.metaCategory')} value={ticket.category?.name} />
                <Meta label={t('share.metaDatacenter')} value={ticket.datacenter?.name} />
                <Meta label={t('share.metaCluster')} value={ticket.cluster?.name} />
                <Meta label={t('share.metaSerialNumber')} value={ticket.serialNumber} />
                <Meta label={t('share.metaCreatedAt')} value={fmt.dateTime(ticket.createdAt)} />
              </dl>
            </section>

            <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <header className="border-b border-gray-100 px-5 py-4 dark:border-gray-800 sm:px-6">
                <h2 className="font-semibold">{t('share.conversation')}</h2>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('share.conversationHint')}</p>
              </header>
              {ticket.messages.length ? (
                <div>
                  {ticket.messages.map((message, index) => (
                    <article
                      key={message.id}
                      className={`px-5 py-5 sm:px-6 ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}
                    >
                      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="font-medium text-gray-800 dark:text-gray-100">{message.author.name}</span>
                        <time className="text-xs text-gray-400">{fmt.dateTime(message.createdAt)}</time>
                      </header>
                      <div
                        className="prose prose-sm max-w-none break-words text-gray-700 dark:prose-invert dark:text-gray-200"
                        dangerouslySetInnerHTML={renderHtml(publicBody(message.body))}
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <p className="px-5 py-8 text-sm text-gray-500 dark:text-gray-400 sm:px-6">{t('share.noPublicMessages')}</p>
              )}
            </section>

            <p className="px-1 text-center text-xs leading-5 text-gray-400 dark:text-gray-500">
              {ticket.expiresAt
                ? t('share.publicExpiresAt', { date: fmt.dateTime(ticket.expiresAt) })
                : t('share.publicNeverExpires')}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
