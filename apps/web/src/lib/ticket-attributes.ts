import type { TicketContact } from './contact';

export const CUSTOM_CATEGORY = '__custom__';
export interface AttributeSource {
  title: string;
  priority: string;
  type: { id: string } | null;
  category: { id: string } | null;
  queue: { id: string } | null;
  datacenter: { id: string } | null;
  serialNumber: string | null;
  contact: TicketContact | null;
}
export interface AttributeDraft {
  title: string;
  priority: string;
  typeId: string;
  categoryId: string;
  categoryName: string;
  queueId: string;
  datacenterId: string;
  serialNumber: string;
  contact: TicketContact | null;
}

export function attributeDraft(ticket: AttributeSource): AttributeDraft {
  return {
    title: ticket.title, priority: ticket.priority, typeId: ticket.type?.id ?? '',
    categoryId: ticket.category?.id ?? '', categoryName: '', queueId: ticket.queue?.id ?? '',
    datacenterId: ticket.datacenter?.id ?? '', serialNumber: ticket.serialNumber ?? '',
    contact: ticket.contact ? { ...ticket.contact, emails: [...ticket.contact.emails] } : null,
  };
}

// Send only changed fields: null means clear; absence means preserve. A dialog
// open while another user edits must not overwrite unrelated metadata or SLA.
export function attributePatch(initial: AttributeDraft, current: AttributeDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (current.title.trim() !== initial.title.trim()) patch.title = current.title.trim();
  if (current.priority !== initial.priority) patch.priority = current.priority;
  for (const field of ['typeId', 'queueId', 'datacenterId'] as const) {
    if (current[field] !== initial[field]) patch[field] = current[field] || null;
  }
  if (current.categoryId !== initial.categoryId || current.categoryName !== initial.categoryName) {
    patch.categoryId = current.categoryId === CUSTOM_CATEGORY ? null : current.categoryId || null;
    if (current.categoryId === CUSTOM_CATEGORY) patch.categoryName = current.categoryName.trim();
  }
  if (current.serialNumber.trim() !== initial.serialNumber.trim()) patch.serialNumber = current.serialNumber.trim() || null;
  if (JSON.stringify(current.contact) !== JSON.stringify(initial.contact)) patch.contact = current.contact;
  return patch;
}

export function canEditAttributes(user: { id: string; roles: string[]; permissions: string[] } | null, ticket: { requester: { id: string }; assignee: { id: string } | null }): boolean {
  return !!user?.permissions.includes('ticket:update') && (
    user.roles.includes('admin') || user.roles.includes('supervisor') ||
    ticket.requester.id === user.id || ticket.assignee?.id === user.id
  );
}
