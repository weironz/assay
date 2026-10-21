export const accessEn = {
  title: 'Assign roles', hint: 'Select job roles. Permissions are combined; ticket ownership and visibility rules still apply.',
  search: 'Search role name, ID or permission', all: 'All roles', selected: 'Selected',
  count: '{{count}} selected', results: '{{count}} matching roles', role: 'Role', scope: 'Access scope',
  permissions: 'Permissions', permissionCount: '{{count}} permissions', remove: 'Remove {{name}}',
  none: 'No roles selected', noneHint: 'Select a role from the list to grant access.',
  noResults: 'No matching roles', noResultsHint: 'Try another keyword or clear the search and filters.',
  clear: 'Clear search and filters', loading: 'Loading roles…', failed: 'Could not load roles.', retry: 'Retry',
  admin: 'Full platform access', adminHint: 'Administrator selected: includes user and role management. Assign only when needed.',
  readonly: 'Role permissions are read-only. This page assigns roles; it does not modify their policies.',
  inherited: 'Inherited from company account', inheritedHint: 'These roles are managed by the directory and cannot be removed here.',
  roles: {
    requester: 'Requester', handler: 'Handler', supervisor: 'Supervisor', ticket_viewer_all: 'Ticket observer (global read-only)',
    asset_manager: 'Asset manager', inventory_manager: 'Inventory manager', cop_viewer: 'Operations observer',
    samba_manager: 'Company accounts & file sharing administrator', admin: 'Administrator',
  },
  summaries: {
    requester: 'Create tickets and follow up on your own requests.', handler: 'Process, reply to and update tickets within your access scope.',
    supervisor: 'View all tickets, assign handlers and view statistics.', ticket_viewer_all: 'View all tickets. This role alone cannot edit or reply.',
    asset_manager: 'Maintain assets and view the platform directory.', inventory_manager: 'Manage spare parts, inventory and asset records.',
    cop_viewer: 'Read-only access to assets, inventory and the platform directory.', samba_manager: 'Manage company accounts and shared directories when enabled.',
    admin: 'Manage platform users, roles, tickets, assets and inventory.',
  },
};
type Copy = { [K in keyof typeof accessEn]: typeof accessEn[K] extends string ? string : { [P in keyof typeof accessEn[K]]: string } };
export const accessCn: Copy = {
  title: '分配角色', hint: '按岗位分配角色，多个角色的权限会合并；工单归属与可见范围规则仍然生效。',
  search: '搜索角色名称、标识或权限', all: '全部角色', selected: '已选角色', count: '已选 {{count}} 项', results: '匹配 {{count}} 个角色',
  role: '角色', scope: '权限范围', permissions: '权限明细', permissionCount: '{{count}} 项权限', remove: '移除 {{name}}',
  none: '尚未选择角色', noneHint: '从左侧列表选择需要授予的岗位角色。', noResults: '没有匹配的角色',
  noResultsHint: '试试其他关键词，或清除搜索和筛选条件。', clear: '清除搜索与筛选', loading: '正在加载角色…', failed: '角色加载失败。', retry: '重试',
  admin: '平台完整管理权限', adminHint: '已选择管理员：包含用户与角色管理权限，请按需分配。',
  readonly: '角色权限仅供查看。此处只分配角色，不修改角色的权限策略。',
  inherited: '继承自公司账号', inheritedHint: '这些角色由目录统一管理，不能在此移除。',
  roles: { requester: '提单人', handler: '处理人', supervisor: '主管', ticket_viewer_all: '工单观察员（全局只读）', asset_manager: '资产管理员', inventory_manager: '仓库管理员', cop_viewer: '运营平台观察员', samba_manager: '公司账号与文件共享管理员', admin: '管理员' },
  summaries: {
    requester: '创建工单，跟进和回复自己提交的问题。', handler: '在可访问范围内处理、回复和更新工单。', supervisor: '查看全部工单、指派处理人并查看统计。',
    ticket_viewer_all: '查看全部工单；单独分配此角色不能编辑或回复。', asset_manager: '维护资产信息，查看平台组织目录。', inventory_manager: '管理备品备件、库存及资产记录。',
    cop_viewer: '只读查看资产、库存及平台组织目录。', samba_manager: '管理公司账号与共享目录，需启用对应模块。', admin: '管理平台用户、角色、工单、资产与库存。',
  },
};
export const accessTw: Copy = {
  title: '分配角色', hint: '依職務分配角色，多個角色的權限會合併；工單歸屬與可見範圍規則仍然生效。',
  search: '搜尋角色名稱、識別碼或權限', all: '全部角色', selected: '已選角色', count: '已選 {{count}} 項', results: '符合 {{count}} 個角色',
  role: '角色', scope: '權限範圍', permissions: '權限明細', permissionCount: '{{count}} 項權限', remove: '移除 {{name}}',
  none: '尚未選擇角色', noneHint: '從角色列表選擇需要授予的職務角色。', noResults: '沒有符合的角色',
  noResultsHint: '試試其他關鍵字，或清除搜尋與篩選條件。', clear: '清除搜尋與篩選', loading: '正在載入角色…', failed: '角色載入失敗。', retry: '重試',
  admin: '平台完整管理權限', adminHint: '已選擇管理員：包含使用者與角色管理權限，請依需求分配。',
  readonly: '角色權限僅供檢視。此處只分配角色，不修改角色的權限原則。', inherited: '繼承自公司帳號', inheritedHint: '這些角色由目錄統一管理，無法在此移除。',
  roles: { requester: '提單人', handler: '處理人', supervisor: '主管', ticket_viewer_all: '工單觀察員（全域唯讀）', asset_manager: '資產管理員', inventory_manager: '倉庫管理員', cop_viewer: '營運平台觀察員', samba_manager: '公司帳號與檔案共用管理員', admin: '管理員' },
  summaries: {
    requester: '建立工單，追蹤與回覆自己提交的問題。', handler: '在可存取範圍內處理、回覆與更新工單。', supervisor: '檢視全部工單、指派處理人並檢視統計。',
    ticket_viewer_all: '檢視全部工單；單獨分配此角色無法編輯或回覆。', asset_manager: '維護資產資訊，檢視平台組織目錄。', inventory_manager: '管理備品備件、庫存與資產記錄。',
    cop_viewer: '唯讀檢視資產、庫存與平台組織目錄。', samba_manager: '管理公司帳號與共用目錄，需啟用對應模組。', admin: '管理平台使用者、角色、工單、資產與庫存。',
  },
};
export const accessTh: Copy = {
  title: 'กำหนดบทบาท', hint: 'เลือกบทบาทตามหน้าที่ สิทธิ์จะรวมกัน โดยยังใช้กฎเจ้าของและการมองเห็นทิกเก็ต',
  search: 'ค้นหาชื่อบทบาท รหัส หรือสิทธิ์', all: 'บทบาททั้งหมด', selected: 'ที่เลือก', count: 'เลือก {{count}} รายการ', results: 'พบ {{count}} บทบาท',
  role: 'บทบาท', scope: 'ขอบเขตสิทธิ์', permissions: 'รายละเอียดสิทธิ์', permissionCount: '{{count}} สิทธิ์', remove: 'นำ {{name}} ออก',
  none: 'ยังไม่ได้เลือกบทบาท', noneHint: 'เลือกบทบาทที่ต้องการให้สิทธิ์จากรายการ', noResults: 'ไม่พบบทบาทที่ตรงกัน',
  noResultsHint: 'ลองคำค้นอื่น หรือล้างการค้นหาและตัวกรอง', clear: 'ล้างการค้นหาและตัวกรอง', loading: 'กำลังโหลดบทบาท…', failed: 'โหลดบทบาทไม่สำเร็จ', retry: 'ลองใหม่',
  admin: 'สิทธิ์จัดการแพลตฟอร์มทั้งหมด', adminHint: 'เลือกผู้ดูแลระบบแล้ว ซึ่งรวมสิทธิ์จัดการผู้ใช้และบทบาท โปรดมอบหมายเท่าที่จำเป็น',
  readonly: 'รายละเอียดสิทธิ์เป็นแบบอ่านอย่างเดียว หน้านี้ใช้กำหนดบทบาท ไม่ใช่แก้ไขนโยบาย', inherited: 'สืบทอดจากบัญชีบริษัท', inheritedHint: 'บทบาทเหล่านี้จัดการโดยไดเรกทอรีและไม่สามารถนำออกได้ที่นี่',
  roles: { requester: 'ผู้แจ้ง', handler: 'ผู้ดำเนินการ', supervisor: 'หัวหน้างาน', ticket_viewer_all: 'ผู้สังเกตการณ์ทิกเก็ต (อ่านทั้งหมด)', asset_manager: 'ผู้ดูแลสินทรัพย์', inventory_manager: 'ผู้ดูแลคลัง', cop_viewer: 'ผู้สังเกตการณ์แพลตฟอร์ม', samba_manager: 'ผู้ดูแลบัญชีบริษัทและไฟล์ที่แชร์', admin: 'ผู้ดูแลระบบ' },
  summaries: {
    requester: 'สร้างทิกเก็ต ติดตามและตอบปัญหาที่ตนแจ้ง', handler: 'ดำเนินการ ตอบและปรับปรุงทิกเก็ตภายในขอบเขตที่เข้าถึงได้', supervisor: 'ดูทิกเก็ตทั้งหมด มอบหมายผู้ดำเนินการ และดูสถิติ',
    ticket_viewer_all: 'ดูทิกเก็ตทั้งหมด บทบาทนี้เพียงอย่างเดียวแก้ไขหรือตอบไม่ได้', asset_manager: 'ดูแลข้อมูลสินทรัพย์และดูไดเรกทอรีองค์กร', inventory_manager: 'จัดการอะไหล่ คลังสินค้า และข้อมูลสินทรัพย์',
    cop_viewer: 'ดูสินทรัพย์ คลังสินค้า และไดเรกทอรีแบบอ่านอย่างเดียว', samba_manager: 'จัดการบัญชีบริษัทและโฟลเดอร์ที่แชร์เมื่อติดตั้งโมดูลแล้ว', admin: 'จัดการผู้ใช้ บทบาท ทิกเก็ต สินทรัพย์ และคลังสินค้า',
  },
};
