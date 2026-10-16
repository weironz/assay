import { z } from 'zod';
const id = z.string().regex(/^[a-fA-F0-9]{32}$/);
const name = z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/);
const display = z.string().min(1).max(128).refine(v => !/[\x00-\x1f\x7f]/.test(v));
const password = z.string().min(8).max(512).refine(v => !v.includes('\0'));
const optionalText = (max: number) => z.string().max(max).refine(v => !/[\x00-\x1f\x7f]/.test(v)).optional();
export const employeeProfile = z.object({
  employee_id: optionalText(16),
  email: z.union([z.literal(''), z.email().max(254)]).optional(),
  department: optionalText(64), title: optionalText(64),
  phone: optionalText(64), company: optionalText(64), office: optionalText(128),
}).strict();
const path = z.string().max(1024).refine(v => v === '' || (!v.startsWith('/') && !/[\\\x00:]/.test(v) && v.split('/').every(p => p && p !== '.' && p !== '..')));
export const directoryPath = z.object({ share: name, path }).strict();
export const actions = {
  'user.create': z.object({ name, display_name: display, password, profile: employeeProfile.optional() }).strict(),
  'user.update': z.object({ id, display_name: display, disabled: z.boolean(), profile: employeeProfile.optional() }).strict(),
  'user.password': z.object({ id, password }).strict(),
  'group.create': z.object({ name, description: display }).strict(),
  'group.update': z.object({ id, description: display }).strict(),
  'group.delete': z.object({ id }).strict(),
  'group.member': z.object({ group_id: id, user_id: id, add: z.boolean() }).strict(),
  'group.members': z.object({ group_id: id, user_ids: z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length), add: z.boolean() }).strict(),
  'share.save': z.object({ name, comment: display, groups: z.array(id).max(100), read_only: z.boolean() }).strict(),
  'share.remove': z.object({ name }).strict(),
  'directory.create': directoryPath.refine(v => v.path.length > 0),
  'directory.delete': directoryPath.refine(v => v.path.length > 0),
  'acl.grant': z.object({ share: name, path, principal_id: id, group: z.boolean(), mode: z.enum(['read', 'modify', 'full', 'remove']), inherit: z.boolean(), revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
};
export const commandSchema = z.object({ requestId: z.uuid(), action: z.enum(Object.keys(actions) as [keyof typeof actions, ...(keyof typeof actions)[]]), args: z.record(z.string(), z.unknown()) }).strict();
export const bindingSchema = z.object({ userId: z.string().min(1).max(128), adObjectId: id.nullable() }).strict();
export const selfPasswordSchema = z.object({ requestId: z.uuid(), old_password: password, password, code: z.string().regex(/^\d{6}$/).optional() }).strict();
export function metadata(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !/password|token|secret/i.test(key)));
}
