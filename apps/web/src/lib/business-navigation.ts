export interface MenuItem {
  to: string;
  labelKey: string;
  permission?: string;
  anyPermissions?: string[];
  groupKey?: string;
  feature?: 'directory' | 'files';
}

export interface BusinessModule {
  id: string;
  labelKey: string;
  areas: string[];
  items: MenuItem[];
}

export const BUSINESS_MODULES: BusinessModule[] = [
  {
    id: 'tickets',
    labelKey: 'nav.ticketSystem',
    areas: ['/tickets', '/queues', '/sla'],
    items: [
      {
        to: '/tickets/dashboard',
        labelKey: 'nav.dashboard',
        permission: 'ticket:read',
      },
      { to: '/tickets', labelKey: 'nav.ticketList', permission: 'ticket:read' },
      {
        to: '/tickets/new',
        labelKey: 'nav.newTicket',
        permission: 'ticket:create',
      },
      { to: '/queues', labelKey: 'nav.queues', permission: 'queue:manage' },
      { to: '/sla', labelKey: 'nav.sla', permission: 'queue:manage' },
    ],
  },
  {
    id: 'assets',
    labelKey: 'cop.assets',
    areas: ['/assets'],
    items: [
      {
        to: '/assets',
        labelKey: 'nav.assetRegister',
        permission: 'asset:read',
      },
      {
        to: '/assets/import',
        labelKey: 'cop.importAssets',
        permission: 'asset:manage',
      },
    ],
  },
  {
    id: 'spares',
    labelKey: 'nav.sparesInventory',
    areas: ['/spare-parts', '/inventory'],
    items: [
      {
        to: '/spare-parts',
        labelKey: 'nav.partsCatalogue',
        permission: 'inventory:read',
      },
      {
        to: '/inventory?view=balances',
        labelKey: 'cop.balances',
        permission: 'inventory:read',
      },
      {
        to: '/inventory?view=operations',
        labelKey: 'cop.operations',
        permission: 'inventory:read',
      },
      {
        to: '/inventory?view=warehouses',
        labelKey: 'cop.warehouses',
        permission: 'inventory:read',
      },
    ],
  },
  {
    id: 'files', labelKey: 'nav.fileManagement', areas: ['/files', '/samba'],
    items: [
      { to: '/files', labelKey: 'nav.sharedFiles', feature: 'files', groupKey: 'nav.fileAccess' },
      { to: '/samba/overview', labelKey: 'nav.administrationHome', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/users', labelKey: 'nav.directoryEmployees', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/health', labelKey: 'nav.directoryHealth', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/import', labelKey: 'nav.directoryImport', permission: 'samba:manage', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/dns', labelKey: 'nav.directoryDns', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/sessions', labelKey: 'nav.directorySessions', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/groups', labelKey: 'nav.directoryGroups', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/shares', labelKey: 'nav.sharedDirectories', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/bindings', labelKey: 'nav.accountLinks', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
      { to: '/samba/history', labelKey: 'nav.directoryOperations', permission: 'samba:read', feature: 'directory', groupKey: 'nav.fileAdministration' },
    ],
  },
];

export const PLATFORM_PERMISSIONS = [
  'organization:manage',
  'user:manage',
];
export const PLATFORM_MODULE: BusinessModule = {
  id: 'platform',
  labelKey: 'nav.platformManagement',
  areas: ['/platform', '/organization', '/users', '/directory-settings'],
  items: [
    {
      to: '/platform',
      labelKey: 'nav.administrationHome',
      anyPermissions: PLATFORM_PERMISSIONS,
    },
    { to: '/directory-settings', labelKey: 'nav.identityIntegration', permission: 'user:manage', groupKey: 'nav.platformAccess' },
    {
      to: '/organization',
      labelKey: 'cop.organization',
      permission: 'organization:manage',
      groupKey: 'nav.platformAccess',
    },
    {
      to: '/users',
      labelKey: 'nav.userPermissions',
      permission: 'user:manage',
      groupKey: 'nav.platformAccess',
    },
  ],
};

export function allowedItems(
  items: MenuItem[],
  has: (permission: string) => boolean,
  features: Partial<Record<'directory' | 'files', boolean>> = {},
) {
  return items.filter(
    (item) =>
      (!item.feature || features[item.feature] === true) &&
      (!item.permission || has(item.permission)) &&
      (!item.anyPermissions || item.anyPermissions.some(has)),
  );
}

// Management-capable users enter the directory overview; employees enter files.
// Resolve from visible items so a disabled module never becomes a destination.
export function moduleHome(
  module: BusinessModule,
  has: (permission: string) => boolean,
  features: Partial<Record<'directory' | 'files', boolean>> = {},
) {
  const items = allowedItems(module.items, has, features);
  return (module.id === 'files' ? items.find(item => item.to === '/samba/overview') : undefined)?.to
    || items[0]?.to || '/dashboard';
}

export function moduleForPath(pathname: string) {
  return [...BUSINESS_MODULES, PLATFORM_MODULE].find((module) =>
    module.areas.some(
      (area) => pathname === area || pathname.startsWith(area + '/'),
    ),
  );
}

export type InventoryView = 'operations' | 'balances' | 'warehouses';
export function inventoryView(params: URLSearchParams): InventoryView {
  const view = params.get('view');
  return view === 'balances' || view === 'warehouses' ? view : 'operations';
}

export function activeMenuItem(
  items: MenuItem[],
  pathname: string,
  params: URLSearchParams,
) {
  return items
    .filter((item) => {
      const [path, query] = item.to.split('?');
      if (pathname !== path && !pathname.startsWith(path + '/')) return false;
      return (
        !query ||
        inventoryView(params) === new URLSearchParams(query).get('view')
      );
    })
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
}

// Keep the current inventory filters when changing its left-hand view.
export function menuHref(
  item: MenuItem,
  pathname: string,
  params: URLSearchParams,
) {
  if (pathname !== '/inventory' || !item.to.startsWith('/inventory?'))
    return item.to;
  const next = new URLSearchParams(params);
  next.delete('page');
  next.set('view', new URLSearchParams(item.to.split('?')[1]).get('view')!);
  return '/inventory?' + next.toString();
}
