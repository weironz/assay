import { sha256 } from '@noble/hashes/sha2.js';
export interface ImportRow {
  name: string;
  site: string;
  sourceSystem: 'excel' | 'netbox';
  sourceRecordId: string;
  code?: string;
  serialNumber?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  rackName?: string;
  rackUnit?: string;
  sourceStatus?: string;
}
export interface ImportSheet {
  name: string;
  rows: Record<string, string>[];
}
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw Error('CSV quotes are not balanced');
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
function zipBounds(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (
    let i = buffer.byteLength - 22;
    i >= Math.max(0, buffer.byteLength - 65557);
    i--
  )
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw Error('Invalid XLSX archive');
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  let total = 0;
  if (count > 2000 || offset >= buffer.byteLength)
    throw Error('Workbook archive is too large');
  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > buffer.byteLength ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw Error('Invalid workbook archive');
    total += view.getUint32(offset + 24, true);
    if (total > 64 * 1024 * 1024) throw Error('Workbook expands beyond 64 MiB');
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
}
function records(rows: string[][]): Record<string, string>[] {
  const headers = rows[0]?.map((h) => h.replace(/^\uFEFF/, '').trim()) ?? [];
  return rows
    .slice(1)
    .filter((r) => r.some((v) => v.trim()))
    .map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, row[i]?.trim() || ''])),
    );
}
export async function readImportFile(file: File): Promise<ImportSheet[]> {
  if (file.size > 8 * 1024 * 1024) throw Error('Maximum file size: 8 MiB');
  if (/\.csv$/i.test(file.name))
    return [{ name: file.name, rows: records(csvRows(await file.text())) }];
  if (!/\.xlsx$/i.test(file.name))
    throw Error('Choose an XLSX or UTF-8 CSV file');
  const buffer = await file.arrayBuffer();
  zipBounds(buffer);
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  // Never expose or transmit credential, network, interface or component sheets.
  const sheets: ImportSheet[] = [];
  workbook.eachSheet((sheet) => {
    if (!/^(设备清单|资产清单|devices|assets)$/i.test(sheet.name)) return;
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      rows.push(
        Array.from(
          { length: sheet.columnCount },
          (_, i) => row.getCell(i + 1).text,
        ),
      );
    });
    sheets.push({ name: sheet.name, rows: records(rows) });
  });
  if (!sheets.length)
    throw Error('No equipment worksheet found (设备清单 / devices / assets)');
  return sheets;
}
export async function mapImportRows(
  rows: Record<string, string>[],
): Promise<ImportRow[]> {
  if (rows.length > 500) throw Error('Maximum 500 devices per import');
  const pick = (r: Record<string, string>, ...keys: string[]) =>
    keys.map((k) => r[k]?.trim()).find(Boolean) || '';
  return Promise.all(
    rows.map(async (r) => {
      const name = pick(r, 'device_name', 'name', '设备名称', '名称');
      const site = pick(r, 'site_slug', 'site', '站点');
      const serialNumber = pick(r, 'serial', 'serialNumber', '序列号', 'SN');
      const legacy = pick(r, 'asset_id');
      const bytes = sha256(
        new TextEncoder().encode(
          site.toLowerCase() +
            ':' +
            (legacy || serialNumber || name).toUpperCase(),
        ),
      );
      const sourceRecordId = Array.from(bytes, (v) =>
        v.toString(16).padStart(2, '0'),
      ).join('');
      const code = pick(r, 'asset_tag', 'code', '资产编号');
      const optional = {
        code,
        serialNumber,
        category: pick(r, 'role_slug', 'role', 'category', '分类'),
        manufacturer: pick(r, 'manufacturer', 'manufacturer_slug', '厂商'),
        model: pick(r, 'model', 'device_type', 'device_type_slug', '型号'),
        rackName: pick(r, 'rack_name', 'rack', '机柜'),
        rackUnit: pick(r, 'position', 'rackUnit', 'U位'),
        sourceStatus: pick(r, 'status'),
      };
      return {
        name,
        site,
        sourceSystem: 'excel' as const,
        sourceRecordId,
        ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v)),
      };
    }),
  );
}
