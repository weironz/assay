import { describe, test, expect } from 'bun:test';
import ExcelJS from 'exceljs';
import { readImportFile, mapImportRows } from '../src/features/cop/import';
import { requestId } from '../src/features/cop/ids';

describe('COP inventory import', () => {
  test('reads only device sheets and transmits only mapped equipment fields', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('设备清单').addRows([
      ['device_name', 'site_slug', 'serial', 'asset_tag', 'password'],
      [
        'server-01',
        'readyidc',
        'SN001',
        'GS-000059',
        'must-not-leave-the-file',
      ],
    ]);
    workbook
      .addWorksheet('账号密码')
      .addRows([['password'], ['private-account-value']]);
    workbook
      .addWorksheet('硬件清单')
      .addRows([['name'], ['installed-card-is-not-stock']]);
    const file = new File(
      [await workbook.xlsx.writeBuffer()],
      'inventory.xlsx',
    );
    const sheets = await readImportFile(file);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['设备清单']);
    const rows = await mapImportRows(sheets[0].rows);
    expect(rows[0].code).toBe('GS-000059');
    expect(JSON.stringify(rows)).not.toContain('must-not-leave');
    expect(JSON.stringify(rows)).not.toContain('password');
  });

  test('legacy Datazone ID is stable identity, not a GS number; chassis height is not rack position', async () => {
    const input = [
      {
        device_name: 'server-dz',
        site: 'datazone',
        asset_id: 'legacy-001',
        u_height: '4',
        role: 'b300',
        serial: 'S1',
      },
    ];
    const [a] = await mapImportRows(input),
      [b] = await mapImportRows(input);
    expect(a.code).toBeUndefined();
    expect(a.rackUnit).toBeUndefined();
    expect(a.sourceRecordId).toBe(b.sourceRecordId);
    expect(a.sourceRecordId).toMatch(/^[a-f0-9]{64}$/);
    expect(a.category).toBe('b300'); // The API explicitly normalizes this legacy role.
  });

  test('handles UTF-8 BOM, quoted commas, double quotes and embedded newlines', async () => {
    const file = new File(
      [
        '\uFEFFdevice_name,site,serial\r\n"server, ""A""",datazone,"SN\n01"\r\n',
      ],
      'assets.csv',
    );
    const [sheet] = await readImportFile(file);
    expect(sheet.rows).toEqual([
      { device_name: 'server, "A"', site: 'datazone', serial: 'SN\n01' },
    ]);
  });

  test('rejects malformed CSV, unsupported formats and oversized batches/files', async () => {
    await expect(
      readImportFile(new File(['"open'], 'assets.csv')),
    ).rejects.toThrow('quotes');
    await expect(
      readImportFile(new File(['text'], 'assets.xls')),
    ).rejects.toThrow('XLSX');
    await expect(
      readImportFile(
        new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'assets.csv'),
      ),
    ).rejects.toThrow('8 MiB');
    await expect(
      mapImportRows(Array.from({ length: 501 }, () => ({}))),
    ).rejects.toThrow('500');
  });

  test('rejects workbooks consisting only of credentials sheets', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('账号密码').addRows([
      ['user', 'password'],
      ['private', 'secret'],
    ]);
    await expect(
      readImportFile(
        new File([await workbook.xlsx.writeBuffer()], 'accounts.xlsx'),
      ),
    ).rejects.toThrow('No equipment worksheet');
  });

  test('random operation IDs work without secure-context-only crypto methods', () => {
    const values = Array.from({ length: 50 }, () => requestId());
    expect(new Set(values).size).toBe(50);
    expect(
      values.every((value) =>
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value,
        ),
      ),
    ).toBe(true);
  });
});
