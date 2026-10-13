import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
export interface Named {
  id: string;
  name: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface Asset {
  id: string;
  code: string | null;
  name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  location: string | null;
  description: string | null;
  status: string;
  custodianId: string | null;
  departmentId: string | null;
  datacenterId: string | null;
  clusterId: string | null;
  custodian: Named | null;
  department: Named | null;
  datacenter: Named | null;
  cluster: Named | null;
  purchaseDate: string | null;
  purchaseCost: string | null;
  currency: string;
  warrantyUntil: string | null;
  ownerName: string | null;
  ownership: string;
  rackName: string | null;
  rackUnit: string | null;
  labelVerified: boolean;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  lastSyncedAt: string | null;
}
export interface Warehouse extends Named {
  code: string;
  location: string | null;
  departmentId: string | null;
  active: boolean;
}
export interface Balance {
  warehouseId: string;
  sparePartId: string;
  quantity: number;
  warehouse: Warehouse;
  sparePart: Part;
}
export interface Part extends Named {
  sku: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  unit: string;
  minimumStock: number;
  description: string | null;
  active: boolean;
  totalQuantity: number;
  balances: Balance[];
}
export interface StockOperation {
  id: string;
  type: string;
  reason: string;
  actorName: string;
  createdAt: string;
  sparePart: Part;
  asset: Pick<Asset, 'id' | 'code' | 'name'> | null;
  ticket: { id: string; ticketNo: string; title: string } | null;
  reversedBy: { id: string } | null;
  movements: {
    id: string;
    warehouse: Warehouse;
    delta: number;
    before: number;
    after: number;
  }[];
}
export interface Options {
  users: (Named & { departmentId: string | null })[];
  departments: (Named & { active: boolean; parentId: string | null })[];
  datacenters: Named[];
  clusters: (Named & { datacenterId: string | null })[];
}
export const useCopQuery = <T>(
  path: string,
  params?: Record<string, unknown>,
  enabled = true,
) =>
  useQuery<T>({
    queryKey: ['cop', path, params],
    queryFn: async () => (await api.get<T>(path, { params })).data,
    enabled,
  });
export function requestError(error: any) {
  const message = error?.response?.data?.message;
  return Array.isArray(message)
    ? message.join('; ')
    : message || error?.message || 'Request failed';
}
export async function exportCSV(
  path: string,
  params: Record<string, unknown>,
  filename: string,
) {
  const { data } = await api.get(path, { params, responseType: 'blob' });
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
export const useCopCatalogue = <T>(path: string, enabled = true) =>
  useQuery<T[]>({
    queryKey: ['cop', 'catalogue', path],
    enabled,
    queryFn: async () => {
      const items: T[] = [];
      let page = 1;
      while (true) {
        const response = await api.get<Page<T>>(path, {
          params: { page, pageSize: 100 },
        });
        items.push(...response.data.items);
        if (items.length >= response.data.total) return items;
        if (items.length >= 10000)
          throw Error(
            'Use search to select from a catalogue larger than 10000 records',
          );
        page++;
      }
    },
  });
