import { expect, test } from 'bun:test';
import { employeeCommandRows, employeeTemplateCsv, readEmployeeImportFile } from '../src/features/samba/import';
import { filetimeDays, filetimeMinutes } from '../src/features/samba/types';

test('employee import nests optional metadata under profile and preserves password whitespace', async () => {
  const csv='登录账号,员工姓名,初始密码,部门,邮箱\nreview,测试员工,  Secret-Review!  ,技术部,review@example.test\n';
  const rows=await readEmployeeImportFile(new File([csv],'employees.csv'));
  expect(rows[0].password).toBe('  Secret-Review!  ');
  expect(employeeCommandRows(rows)).toEqual([{name:'review',display_name:'测试员工',password:'  Secret-Review!  ',profile:{department:'技术部',email:'review@example.test'}}]);
  const template=await readEmployeeImportFile(new File([employeeTemplateCsv()],'template.csv'));
  expect(employeeCommandRows(template)[0].profile.employee_id).toBe('E001');
});
test('AD lockout durations retain minute precision and sentinel values are explicit', () => {
  expect(filetimeMinutes('-18000000000')).toBe(30);
  expect(filetimeDays('-864000000000')).toBe(1);
  expect(filetimeMinutes('0')).toBeNull();
  expect(filetimeDays('-9223372036854775808')).toBeNull();
  expect(filetimeDays('invalid')).toBeNull();
});
