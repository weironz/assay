import { useTranslation } from 'react-i18next';
import { actionLabel } from '../lib/ticket-meta';

interface Props {
  actions: string[];
  isPending: boolean;
  pendingAction?: string;
  error: unknown;
  onAction: (action: string) => void;
}

export default function TicketWorkflowActions({ actions, isPending, pendingAction, error, onAction }: Props) {
  const { t } = useTranslation();
  const response = (error as { response?: { status?: number } } | null)?.response;
  const errorKey = response?.status === 403 ? 'actionForbidden'
    : response?.status === 409 ? 'actionConflict' : 'actionFailed';
  return <>
    {actions.map(action => <button
      key={action}
      type="button"
      disabled={isPending}
      aria-busy={isPending && action === pendingAction}
      onClick={() => onAction(action)}
      className="rounded-md border border-brand-600 text-brand-700 px-3 py-1.5 text-sm hover:bg-brand-700 hover:text-white disabled:opacity-50"
    >
      {isPending && action === pendingAction
        ? t('ticketDetail.actionPending', { action: actionLabel(t, action) })
        : actionLabel(t, action)}
    </button>)}
    {error && !isPending ? <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">
      {t(`ticketDetail.${errorKey}`)}
    </p> : null}
  </>;
}
