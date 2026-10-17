import { csvRows, records, zipBounds } from '../cop/import';

export interface EmployeeImportRow {
  name: string;
  display_name: string;
  password: string;
  employee_id?: string;
  email?: string;
  department?: string;
  title?: string;
  phone?: string;
  company?: string;
  office?: string;
}

const HEADERS = [
  '登录账号', '员工姓名', '初始密码', '工号', '邮箱', '部门', '岗位', '电话', '公司', '办公地点',
];

export function employeeTemplateCsv() {
  return (
    '\uFEFF' +
    HEADERS.join(',') +
    '\n' +
    ['zhang_san', '张三', 'Init-2026!pass', 'E001', 'zhang@example.com', '技术部', '工程师', '13800000000', '', ''].join(',') +
    '\n'
  );
}

/** 解析 xlsx / csv 为待导入员工行；表头支持中英文列名 */
export async function readEmployeeImportFile(
  file: File,
): Promise<EmployeeImportRow[]> {
  if (file.size > 4 * 1024 * 1024) throw Error('文件大小不能超过 4 MiB');
  let sheetRows: Record<string, string>[];
  if (/\.csv$/i.test(file.name)) {
    sheetRows = records(csvRows(await file.text()), ['password', '初始密码', '密码']);
  } else if (/\.xlsx$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    zipBounds(buffer);
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet =
      workbook.worksheets.find((s) => /^(员工|employees?|users)$/i.test(s.name)) ||
      workbook.worksheets[0];
    if (!sheet) throw Error('未找到数据工作表');
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      rows.push(
        Array.from({ length: sheet.columnCount }, (_, i) => row.getCell(i + 1).text),
      );
    });
    sheetRows = records(rows, ['password', '初始密码', '密码']);
  } else {
    throw Error('请选择 XLSX 或 UTF-8 CSV 文件');
  }
  if (sheetRows.length > 100) throw Error('单次最多导入 100 名员工');
  const pick = (r: Record<string, string>, ...keys: string[]) =>
    keys.map((k) => r[k]?.trim()).find(Boolean) || '';
  return sheetRows.map((r) => ({
    name: pick(r, 'name', '登录账号', '账号'),
    display_name: pick(r, 'display_name', '员工姓名', '姓名'),
    password: ['password', '初始密码', '密码'].map(k => r[k]).find(v => v !== undefined && v !== '') || '',
    employee_id: pick(r, 'employee_id', '工号') || undefined,
    email: pick(r, 'email', '邮箱') || undefined,
    department: pick(r, 'department', '部门') || undefined,
    title: pick(r, 'title', '岗位') || undefined,
    phone: pick(r, 'phone', '电话') || undefined,
    company: pick(r, 'company', '公司') || undefined,
    office: pick(r, 'office', '办公地点') || undefined,
  }));
}

/** Preserve credentials exactly; only employee metadata belongs under profile. */
export function employeeCommandRows(rows: EmployeeImportRow[]) {
  return rows.map(({ name, display_name, password, ...profile }) => ({
    name, display_name, password,
    profile: Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== undefined)),
  }));
}
