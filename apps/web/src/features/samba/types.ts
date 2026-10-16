export type Employee = {
  id: string;
  name: string;
  displayName: string;
  disabled: boolean;
  dn: string;
  sid: string;
  manageable: boolean;
  employeeId: string;
  email: string;
  department: string;
  title: string;
  phone: string;
  company: string;
  office: string;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  members: string[];
  sid: string;
  manageable: boolean;
};
export type Share = {
  name: string;
  comment: string;
  groups: string[];
  read_only: boolean;
  active: boolean;
  external?: boolean;
  path?: string;
  browseable?: boolean;
};
export type Snapshot = {
  enabled: boolean;
  readOnly: boolean;
  domain: string;
  groupPrefix?: string;
  users: Employee[];
  groups: Group[];
  shares: Share[];
  bindings: { userId: string; adObjectId: string; accountName: string; directoryManaged?: boolean }[];
  assayUsers: { id: string; name: string; email: string }[];
};
export type Acl = {
  revision: string;
  protected: boolean;
  owner: string;
  entries: {
    sid?: string;
    effect: string;
    mask?: number;
    inherited: boolean;
    inherit?: boolean;
    details?: string;
  }[];
};
export type Option = { value: string; label: string };
export type Field = {
  name: string;
  label: string;
  type?: 'password' | 'email' | 'checkbox' | 'select' | 'multi';
  options?: Option[];
  optional?: boolean;
  maxLength?: number;
  minLength?: number;
  hint?: string;
};
export type Editor = {
  error?: string;
  title: string;
  action: string;
  fields: Field[];
  values: Record<string, unknown>;
  endpoint?: string;
  description?: string;
};
export type Workspace = {
  snapshot: Snapshot;
  canWrite: boolean;
  open: (editor: Editor) => void;
  confirm: (
    title: string,
    action: string,
    args: unknown,
    onSuccess?: () => void,
  ) => void;
};
export const sameDn = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export const displayDomain = (domain: string) => {
  const parts = domain.match(/(?:^|,)\s*DC=([^,]+)/gi);
  return parts?.length
    ? parts
        .map((part) => part.replace(/^(?:,)?\s*DC=/i, ''))
        .join('.')
        .toLowerCase()
    : domain;
};
export const employeeLabel = (u: Employee) =>
  `${u.displayName || u.name} · ${u.name}${u.employeeId ? ' · ' + u.employeeId : ''}${u.department ? ' · ' + u.department : ''}`;
export const profileFields: Field[] = [
  { name: 'employee_id', label: '工号', optional: true, maxLength: 16 },
  {
    name: 'email',
    label: '邮箱',
    type: 'email',
    optional: true,
    maxLength: 254,
  },
  { name: 'department', label: '部门', optional: true, maxLength: 64 },
  { name: 'title', label: '岗位', optional: true, maxLength: 64 },
  { name: 'phone', label: '电话', optional: true, maxLength: 64 },
  { name: 'company', label: '公司', optional: true, maxLength: 64 },
  { name: 'office', label: '办公地点', optional: true, maxLength: 128 },
];
export const employeeProfileValues = (u?: Employee) => ({
  employee_id: u?.employeeId || '',
  email: u?.email || '',
  department: u?.department || '',
  title: u?.title || '',
  phone: u?.phone || '',
  company: u?.company || '',
  office: u?.office || '',
});
