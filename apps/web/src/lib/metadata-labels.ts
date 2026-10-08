import type { TFunction } from 'i18next';

type MetadataKind = 'type' | 'category' | 'queue';
// Only known seed names are translated. Customer-defined names and asset names
// remain data, never translation keys. IDs are always submitted unchanged.
const BUILT_INS: Record<MetadataKind, Record<string, string>> = {
  type: { '故障': 'incident', '需求': 'request', '咨询': 'question', '諮詢': 'question' },
  category: {
    'IT支持': 'itSupport', '网络': 'network', '網絡': 'network',
    '账号权限': 'accountAccess', '帳號權限': 'accountAccess',
    '软件安装': 'software', '軟體安裝': 'software',
    'IB网络': 'ibNetwork', 'IB網絡': 'ibNetwork',
    '以太网网络': 'ethernet', '乙太網路': 'ethernet', 'GPU卡': 'gpu', 'B300': 'b300',
  },
  queue: { '默认队列': 'defaultQueue', '預設佇列': 'defaultQueue' },
};

export function metadataLabel(t: TFunction, kind: MetadataKind, name: string): string {
  const normalized = name.replace(/\s+/g, '');
  const key = Object.prototype.hasOwnProperty.call(BUILT_INS[kind], normalized)
    ? BUILT_INS[kind][normalized] : undefined;
  return key ? t(`metadata.${key}`, { defaultValue: name }) : name;
}
