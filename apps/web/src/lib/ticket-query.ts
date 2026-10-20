import type { TicketQuery } from '../features/tickets/api';
export const TICKET_FILTER_KEYS = [
  'status',
  'scope',
  'priority',
  'queueId',
  'assigneeId',
  'requesterId',
  'categoryId',
  'ticketNo',
  'keyword',
  'datacenterId',
  'slaState',
  'createdFrom',
  'createdTo',
] as const;
const SCOPES = ['open', 'completed', 'mine', 'unassigned', 'overdue'];
const SLA = ['overdue', 'within', 'paused', 'completed', 'unset'];
export function ticketQueryFromSearch(params: URLSearchParams): TicketQuery {
  const query = Object.fromEntries(
    TICKET_FILTER_KEYS.filter((key) => params.get(key)).map((key) => [
      key,
      params.get(key),
    ]),
  ) as TicketQuery;
  if (!SCOPES.includes(query.scope || '')) delete query.scope;
  if (!SLA.includes(query.slaState || '')) delete query.slaState;
  const page = Number(params.get('page'));
  const size = Number(params.get('pageSize'));
  return {
    ...query,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isSafeInteger(size) && size > 0 && size <= 100 ? size : 20,
  };
}
export function ticketQuerySearch(query: TicketQuery): URLSearchParams {
  const params = new URLSearchParams();
  TICKET_FILTER_KEYS.forEach((key) => {
    if (query[key]) params.set(key, query[key]!);
  });
  if ((query.page ?? 1) > 1) params.set('page', String(query.page));
  if ((query.pageSize ?? 20) !== 20)
    params.set('pageSize', String(query.pageSize));
  return params;
}
// Local calendar days -> UTC instants; the end includes the entire local day.
export function dateBoundary(day: string, end = false): string | undefined {
  if (!day) return undefined;
  const date = new Date(`${day}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
export function boundaryDate(value?: string, end = false): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (end) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
