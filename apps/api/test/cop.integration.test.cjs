const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, writeFile, access, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const isolated = process.env.COP_TEST_DATABASE_URL;
if (!isolated) {
  test(
    'COP integration requires an isolated PostgreSQL URL',
    { skip: true },
    () => {},
  );
} else {
  assert.match(
    new URL(isolated).pathname,
    /_cop_test$/,
    'Refuse to run COP integration against a live database',
  );
  process.env.DATABASE_URL = isolated;
  const { PrismaClient } = require('@prisma/client');
  const { PlatformService } = require('../src/operations/platform.service');
  const { AssetsService } = require('../src/operations/assets.service');
  const { InventoryService } = require('../src/operations/inventory.service');
  const { AssetImportService } = require('../src/operations/import.service');
  const { BusinessFilesService } = require('../src/operations/files.service');
  const { adapter, csv } = require('../src/operations/business');
  const db = new PrismaClient(),
    platform = new PlatformService(db),
    assets = new AssetsService(db, platform),
    inventory = new InventoryService(db, platform),
    importer = new AssetImportService(db);
  const suffix = randomUUID();
  let actor, other;
  const users = [],
    parts = [],
    warehouses = [],
    assetIds = [],
    departments = [],
    tickets = [],
    batches = [];
  const auth = (
    u,
    permissions = [
      'asset:read',
      'asset:manage',
      'inventory:read',
      'inventory:manage',
      'organization:manage',
      'platform:directory',
      'ticket:read',
      'ticket:read:all',
    ],
  ) => ({
    id: u.id,
    name: u.name,
    roles: ['admin'],
    permissions,
    authType: 'session',
  });
  const rejected = (code) => (error) => error.getStatus?.() === code;
  async function fixture(stock = 0) {
    const part = await inventory.savePart(auth(actor), {
      sku: 'TEST-' + randomUUID(),
      name: 'Fixture part',
      unit: 'pcs',
      minimumStock: 2,
    });
    parts.push(part.id);
    const w = await inventory.saveWarehouse(auth(actor), {
      code: 'TEST-' + randomUUID(),
      name: 'Fixture warehouse',
    });
    warehouses.push(w.id);
    if (stock) await post(part, w, 'RECEIVE', stock);
    return { part, w };
  }
  const post = (part, w, type, quantity, extra = {}) =>
    inventory.post(auth(actor), {
      type,
      sparePartId: part.id,
      warehouseId: w.id,
      quantity,
      reason: 'Integration verification',
      idempotencyKey: randomUUID(),
      ...extra,
    });
  const balance = (part, w) =>
    db.stockBalance
      .findUnique({
        where: {
          warehouseId_sparePartId: { warehouseId: w.id, sparePartId: part.id },
        },
      })
      .then((b) => b?.quantity ?? 0);
  test.before(async () => {
    actor = await db.user.create({
      data: {
        name: 'COP test actor',
        email: 'cop-' + suffix + '@example.test',
      },
    });
    other = await db.user.create({
      data: {
        name: 'COP test other',
        email: 'cop-other-' + suffix + '@example.test',
      },
    });
    users.push(actor.id, other.id);
  });
  test.after(async () => {
    await db.businessAttachment.deleteMany({
      where: { uploaderId: { in: users } },
    });
    await db.businessActivity.deleteMany({ where: { actorId: { in: users } } });
    await db.stockMovement.deleteMany({
      where: { operation: { actorId: { in: users } } },
    });
    await db.inventoryOperation.deleteMany({
      where: { actorId: { in: users }, type: 'REVERSAL' },
    });
    await db.inventoryOperation.deleteMany({
      where: { actorId: { in: users } },
    });
    await db.stockBalance.deleteMany({ where: { sparePartId: { in: parts } } });
    await db.sparePart.deleteMany({ where: { id: { in: parts } } });
    await db.warehouse.deleteMany({ where: { id: { in: warehouses } } });
    await db.ticketAsset.deleteMany({ where: { assetId: { in: assetIds } } });
    await db.asset.deleteMany({ where: { id: { in: assetIds } } });
    await db.ticket.deleteMany({ where: { id: { in: tickets } } });
    await db.assetImportBatch.deleteMany({ where: { id: { in: batches } } });
    await db.user.updateMany({
      where: { id: { in: users } },
      data: { departmentId: null },
    });
    await db.department.updateMany({
      where: { id: { in: departments } },
      data: { parentId: null },
    });
    await db.department.deleteMany({ where: { id: { in: departments } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  test('automatic GS numbers are unique, immutable, and remain with retired equipment', async () => {
    const records = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        assets.save(auth(actor), { name: 'Test asset ' + i }),
      ),
    );
    assetIds.push(...records.map((r) => r.id));
    assert.equal(new Set(records.map((r) => r.code)).size, 5);
    assert.ok(
      records.every(
        (r) =>
          /^GS-\d{6,}$/.test(r.code) && r.status === 'PENDING_REGISTRATION',
      ),
    );
    await assert.rejects(
      assets.save(
        auth(actor),
        { name: 'Renamed', code: 'GS-999999' },
        records[0].id,
      ),
      rejected(400),
    );
    const original = records[0];
    await assert.rejects(
      assets.save(
        auth(actor),
        { name: original.name, status: 'IN_USE', custodianId: actor.id },
        original.id,
      ),
      rejected(400),
    );
    const enabled = await assets.save(
      auth(actor),
      {
        name: original.name,
        status: 'IN_USE',
        custodianId: actor.id,
        labelVerified: true,
      },
      original.id,
    );
    assert.equal(enabled.code, original.code);
    await assets.save(
      auth(actor),
      { name: original.name, status: 'RETIRED', labelVerified: true },
      original.id,
    );
    await assert.rejects(
      assets.save(
        auth(actor),
        { name: original.name, status: 'IN_STOCK', labelVerified: true },
        original.id,
      ),
      rejected(400),
    );
    const events = await db.businessActivity.count({
      where: { kind: 'asset', entityId: original.id },
    });
    assert.equal(events, 3);
  });
  test('department cycles are rejected and employee membership is audited', async () => {
    const parent = await platform.department(auth(actor), {
      name: 'Parent ' + suffix,
    });
    departments.push(parent.id);
    const child = await platform.department(auth(actor), {
      name: 'Child ' + suffix,
      parentId: parent.id,
    });
    departments.push(child.id);
    await assert.rejects(
      platform.department(
        auth(actor),
        { name: parent.name, parentId: child.id },
        parent.id,
      ),
      rejected(400),
    );
    await platform.membership(auth(actor), other.id, child.id);
    assert.equal(
      (await db.user.findUnique({ where: { id: other.id } })).departmentId,
      child.id,
    );
    assert.equal(
      await db.businessActivity.count({
        where: {
          kind: 'department',
          entityId: child.id,
          action: 'MEMBER_CHANGED',
        },
      }),
      1,
    );
  });
  test('receipt is idempotent, payload mismatch is rejected and no balance is duplicated', async () => {
    const { part, w } = await fixture();
    const payload = {
      type: 'RECEIVE',
      sparePartId: part.id,
      warehouseId: w.id,
      quantity: 10,
      reason: 'Receipt',
      idempotencyKey: randomUUID(),
    };
    const [a, b] = await Promise.all([
      inventory.post(auth(actor), payload),
      inventory.post(auth(actor), payload),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(await balance(part, w), 10);
    await assert.rejects(
      inventory.post(auth(actor), { ...payload, quantity: 11 }),
      rejected(409),
    );
    assert.equal(
      await db.inventoryOperation.count({ where: { sparePartId: part.id } }),
      1,
    );
  });
  test('insufficient issue rolls back operation, movement and audit', async () => {
    const { part, w } = await fixture(3);
    const before = await db.businessActivity.count({
      where: { kind: 'spare_part', entityId: part.id },
    });
    await assert.rejects(post(part, w, 'ISSUE', 4), rejected(409));
    assert.equal(await balance(part, w), 3);
    assert.equal(
      await db.inventoryOperation.count({ where: { sparePartId: part.id } }),
      1,
    );
    assert.equal(
      await db.businessActivity.count({
        where: { kind: 'spare_part', entityId: part.id },
      }),
      before,
    );
  });
  test('simultaneous issues cannot produce negative stock', async () => {
    const { part, w } = await fixture(5);
    const results = await Promise.allSettled([
      post(part, w, 'ISSUE', 4),
      post(part, w, 'ISSUE', 4),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await balance(part, w), 1);
    assert.equal(
      await db.stockMovement.count({ where: { sparePartId: part.id } }),
      2,
    );
  });
  test('transfer posts two balanced movements and a failed destination rolls back both', async () => {
    const { part, w } = await fixture(10);
    const target = await inventory.saveWarehouse(auth(actor), {
      code: 'TEST-' + randomUUID(),
      name: 'Target warehouse',
    });
    warehouses.push(target.id);
    const op = await post(part, w, 'TRANSFER', 3, {
      destinationWarehouseId: target.id,
    });
    assert.equal(op.movements.length, 2);
    assert.equal(
      op.movements.reduce((n, m) => n + m.delta, 0),
      0,
    );
    assert.equal(await balance(part, w), 7);
    assert.equal(await balance(part, target), 3);
    const count = await db.inventoryOperation.count({
      where: { sparePartId: part.id },
    });
    await assert.rejects(
      post(part, w, 'TRANSFER', 1, { destinationWarehouseId: 'missing' }),
      rejected(400),
    );
    assert.equal(await balance(part, w), 7);
    assert.equal(
      await db.inventoryOperation.count({ where: { sparePartId: part.id } }),
      count,
    );
  });
  test('stock counts record differences, return restores stock and same-quantity count is refused', async () => {
    const { part, w } = await fixture(10);
    const op = await post(part, w, 'ADJUST', 7);
    assert.equal(op.movements[0].delta, -3);
    assert.equal(await balance(part, w), 7);
    await post(part, w, 'RETURN', 2);
    assert.equal(await balance(part, w), 9);
    await assert.rejects(post(part, w, 'ADJUST', 9), rejected(400));
  });
  test('reversal uses compensating movements, checks available stock and only runs once', async () => {
    const { part, w } = await fixture();
    const receipt = await post(part, w, 'RECEIVE', 10);
    const issue = await post(part, w, 'ISSUE', 6);
    const reverse = (id) =>
      inventory.post(auth(actor), {
        type: 'REVERSAL',
        reversesId: id,
        reason: 'Reverse test',
        idempotencyKey: randomUUID(),
      });
    await assert.rejects(reverse(receipt.id), rejected(409));
    assert.equal(await balance(part, w), 4);
    const reverted = await reverse(issue.id);
    assert.equal(await balance(part, w), 10);
    assert.equal(reverted.movements[0].delta, 6);
    await assert.rejects(reverse(issue.id), rejected(400));
    await assert.rejects(reverse(reverted.id), rejected(400));
    await reverse(receipt.id);
    assert.equal(await balance(part, w), 0);
  });
  test('warehouses and SKUs with stock cannot be disabled; SQL cannot bypass nonnegative balance', async () => {
    const { part, w } = await fixture(2);
    await assert.rejects(
      inventory.savePart(auth(actor), { ...part, active: false }, part.id),
      rejected(400),
    );
    await assert.rejects(
      inventory.saveWarehouse(auth(actor), { ...w, active: false }, w.id),
      rejected(400),
    );
    await assert.rejects(
      db.stockBalance.update({
        where: {
          warehouseId_sparePartId: { warehouseId: w.id, sparePartId: part.id },
        },
        data: { quantity: -1 },
      }),
    );
    assert.equal(await balance(part, w), 2);
  });
  test('business adapters enforce access and reject unknown object kinds', async () => {
    assert.throws(() => adapter('__proto__'), rejected(400));
    assert.throws(() => adapter('constructor'), rejected(400));
    await assert.rejects(
      platform.subject(auth(actor, []), 'asset', assetIds[0]),
      rejected(403),
    );
    await assert.rejects(
      platform.subject(auth(actor, ['asset:read']), 'asset', assetIds[0], true),
      rejected(403),
    );
    assert.equal(
      (
        await platform.subject(
          auth(actor, ['asset:read']),
          'asset',
          assetIds[0],
        )
      ).id,
      assetIds[0],
    );
  });
  test('ticket visibility applies to linking and related-ticket reads', async () => {
    const visible = await db.ticket.create({
      data: {
        ticketNo: 'COP-' + randomUUID(),
        title: 'Owned ticket',
        requesterId: actor.id,
      },
    });
    const hidden = await db.ticket.create({
      data: {
        ticketNo: 'COP-' + randomUUID(),
        title: 'Hidden ticket',
        requesterId: other.id,
      },
    });
    tickets.push(visible.id, hidden.id);
    const limited = auth(actor, ['ticket:read', 'asset:read', 'asset:manage']);
    await assets.link(limited, assetIds[0], visible.id);
    await assert.rejects(
      assets.link(limited, assetIds[0], hidden.id),
      rejected(403),
    );
    await assets.link(auth(actor), assetIds[0], hidden.id);
    assert.deepEqual(
      (await assets.tickets(limited, assetIds[0])).map((t) => t.id),
      [visible.id],
    );
    await assert.rejects(
      assets.ticketAssets(limited, hidden.id),
      rejected(403),
    );
    assert.ok(
      !JSON.stringify(
        await platform.activity(limited, 'asset', assetIds[0]),
      ).includes(hidden.id),
    );
  });
  test('file upload and download use business access rules and remove rejected temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cop-files-'));
    const objects = new Map();
    let reads = 0;
    const storage = {
      putStream: async ({ key, body }) => {
        const chunks = [];
        for await (const c of body) chunks.push(c);
        objects.set(key, Buffer.concat(chunks));
      },
      getStream: async (key) => {
        reads++;
        return require('node:stream').Readable.from(objects.get(key));
      },
      delete: async (key) => objects.delete(key),
    };
    const files = new BusinessFilesService(db, platform, storage);
    const file = async (name) => {
      const path = join(directory, randomUUID());
      await writeFile(path, 'test attachment');
      return { path, originalname: name, size: 15, mimetype: 'text/plain' };
    };
    const upload = await file('manual.txt');
    const record = await files.upload(
      auth(actor),
      'asset',
      assetIds[0],
      upload,
    );
    await assert.rejects(access(upload.path));
    await assert.rejects(
      files.download(auth(actor, []), record.id),
      rejected(403),
    );
    assert.equal(reads, 0);
    const downloaded = await files.download(
      auth(actor, ['asset:read']),
      record.id,
    );
    assert.equal(downloaded.record.fileName, 'manual.txt');
    downloaded.stream.destroy();
    const denied = await file('denied.txt');
    await assert.rejects(
      files.upload(auth(actor, []), 'asset', assetIds[0], denied),
      rejected(403),
    );
    await assert.rejects(access(denied.path));
    assert.equal(objects.size, 1);
    await rm(directory, { recursive: true, force: true });
  });
  test('import preview does not allocate numbers, preserves known tags and commit is idempotent', async () => {
    const rows = [
      {
        name: 'Import test ' + suffix,
        site: 'dz-chonburi',
        sourceSystem: 'excel',
        sourceRecordId: randomUUID(),
        serialNumber: 'SN-' + suffix,
      },
    ];
    const before =
      await db.$queryRaw`SELECT last_value FROM asset_number_sequence`;
    const preview = await importer.preview({ rows });
    const after =
      await db.$queryRaw`SELECT last_value FROM asset_number_sequence`;
    assert.deepEqual(after, before);
    assert.equal(preview.created, 1);
    assert.equal(preview.items[0].site, 'datazone');
    const payload = {
      rows,
      fingerprint: preview.fingerprint,
      idempotencyKey: randomUUID(),
    };
    batches.push(payload.idempotencyKey);
    const result = await importer.commit(auth(actor), payload);
    assetIds.push(...result.ids);
    assert.deepEqual(await importer.commit(auth(actor), payload), result);
    const row = await db.asset.findUnique({ where: { id: result.ids[0] } });
    assert.equal(row.code, null);
    assert.equal(row.status, 'PENDING_REGISTRATION');
    assert.equal(row.ownership, 'UNCONFIRMED');
    const assigned = await assets.register(auth(actor), row.id);
    assert.match(assigned.code, /^GS-\d{6,}$/);
    assert.equal(
      (await assets.register(auth(actor), row.id)).code,
      assigned.code,
    );
    const unnumbered = await db.asset.create({
      data: { name: 'Known preallocated label ' + suffix },
    });
    assetIds.push(unnumbered.id);
    const knownCode =
      'GS-' + String(Number(assigned.code.slice(3)) + 1).padStart(6, '0');
    assert.equal(
      (
        await assets.save(
          auth(actor),
          { name: unnumbered.name, code: knownCode },
          unnumbered.id,
        )
      ).code,
      knownCode,
    );
    assert.equal(
      (await assets.register(auth(actor), unnumbered.id)).code,
      knownCode,
    );
    await assert.rejects(
      assets.save(
        auth(actor),
        { name: unnumbered.name, code: assigned.code },
        unnumbered.id,
      ),
      rejected(400),
    );
  });
  test('import prevents duplicate SN, detects changed preview and preserves COP lifecycle and financial data', async () => {
    const rows = [
      {
        name: 'Protected asset',
        site: 'readyidc',
        sourceSystem: 'netbox',
        sourceRecordId: randomUUID(),
        serialNumber: 'SN-PROTECTED-' + suffix,
        manufacturer: 'Known equipment manufacturer',
      },
    ];
    assert.equal(
      (
        await importer.preview({
          rows: [...rows, { ...rows[0], sourceRecordId: randomUUID() }],
        })
      ).errors,
      1,
    );
    const preview = await importer.preview({ rows });
    const key = randomUUID();
    batches.push(key);
    const result = await importer.commit(auth(actor), {
      rows,
      fingerprint: preview.fingerprint,
      idempotencyKey: key,
    });
    assetIds.push(...result.ids);
    const asset = await assets.register(auth(actor), result.ids[0]);
    await assets.save(
      auth(actor),
      {
        name: asset.name,
        status: 'IN_USE',
        custodianId: actor.id,
        labelVerified: true,
        manufacturer: asset.manufacturer,
        purchaseCost: '1234.56',
      },
      asset.id,
    );
    const next = await importer.preview({
      rows: [{ ...rows[0], name: 'Updated source name' }],
    });
    await assets.save(
      auth(actor),
      {
        name: asset.name,
        status: 'IN_USE',
        custodianId: actor.id,
        labelVerified: true,
        manufacturer: asset.manufacturer,
        purchaseCost: '1234.57',
      },
      asset.id,
    );
    await assert.rejects(
      importer.commit(auth(actor), {
        rows: [{ ...rows[0], name: 'Updated source name' }],
        fingerprint: next.fingerprint,
        idempotencyKey: randomUUID(),
      }),
      rejected(409),
    );
    const refresh = {
      ...rows[0],
      name: 'Updated source name',
      manufacturer: undefined,
    };
    const current = await importer.preview({ rows: [refresh] });
    const id = randomUUID();
    batches.push(id);
    await importer.commit(auth(actor), {
      rows: [refresh],
      fingerprint: current.fingerprint,
      idempotencyKey: id,
    });
    const final = await db.asset.findUnique({ where: { id: asset.id } });
    assert.equal(final.status, 'IN_USE');
    assert.equal(final.custodianId, actor.id);
    assert.equal(final.purchaseCost.toString(), '1234.57');
    assert.equal(final.code, asset.code);
    assert.equal(final.manufacturer, 'Known equipment manufacturer');
  });
  test('import rejects blank sites and multiple rows targeting the same existing asset', async () => {
    const record = await assets.save(auth(actor), {
      name: 'Duplicate identity ' + suffix,
      serialNumber: 'DUP-' + suffix,
    });
    assetIds.push(record.id);
    const first = {
      name: record.name,
      site: 'readyidc',
      sourceSystem: 'excel',
      sourceRecordId: randomUUID(),
      serialNumber: record.serialNumber,
    };
    const second = {
      ...first,
      sourceRecordId: randomUUID(),
      serialNumber: undefined,
      code: record.code,
    };
    assert.equal((await importer.preview({ rows: [first, second] })).errors, 1);
    assert.equal(
      (await importer.preview({ rows: [{ ...first, site: '  ' }] })).errors,
      1,
    );
  });
  test('PostgreSQL enforces registration and pending/unconfirmed defaults', async () => {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO assets (id,name,"updatedAt") VALUES (${id},'Database default verification',NOW())`;
    assetIds.push(id);
    const created = await db.asset.findUnique({ where: { id } });
    assert.equal(created.status, 'PENDING_REGISTRATION');
    assert.equal(created.ownership, 'UNCONFIRMED');
    await assert.rejects(
      db.$executeRaw`UPDATE assets SET status='IN_STOCK' WHERE id=${id}`,
    );
    await assert.rejects(
      db.$executeRaw`UPDATE assets SET "labelVerified"=true WHERE id=${id}`,
    );
  });
  test('CSV neutralizes user-supplied formulas while retaining numeric stock changes', () => {
    const output = csv([['=HYPERLINK("https://example.test")', '+cmd', -3]]);
    assert.ok(output.includes('"\'=HYPERLINK'));
    assert.ok(output.includes('"\'+cmd"'));
    assert.ok(output.includes('"-3"'));
  });
}
