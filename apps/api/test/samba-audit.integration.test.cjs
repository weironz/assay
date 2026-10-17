const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const isolated = process.env.SAMBA_AUDIT_TEST_DATABASE_URL;
if (!isolated) {
  test('Samba audit integration requires an explicit isolated PostgreSQL URL', { skip: true }, () => {});
} else {
  const { PrismaClient } = require('@prisma/client');
  const { SambaService } = require('../src/samba/samba.service');
  const db = new PrismaClient({ datasources: { db: { url: isolated } } });
  const service = new SambaService(db);
  const prefix = `audit-test-${randomUUID()}`;
  const data = (id, action = 'user.unlock') => ({
    id: `${prefix}-${id}`, actorId: 'test-admin', actorName: 'Test Admin', action,
    requestHash: 'test-digest', metadata: { target: 'employee' },
    // All operations intentionally share the same timestamp and arbitrary IDs.
    createdAt: new Date('2026-10-17T00:00:00Z'),
  });
  test.after(async () => {
    await db.sambaOperation.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.$disconnect();
  });
  test('all writers, same-millisecond IDs and result changes form one append-only chain', async () => {
    await Promise.all(['z', 'a', 'm'].map((id, i) => db.sambaOperation.create({ data: data(id, ['user.unlock', 'file.upload', 'directory.identity.link'][i]) })));
    await db.sambaOperation.update({ where: { id: `${prefix}-a` }, data: { state: 'succeeded', result: { message: 'done' } } });
    assert.equal((await service.audit()).valid, true);
    const events = await db.sambaAuditEvent.findMany({ where: { operationId: { startsWith: prefix } }, orderBy: { sequence: 'asc' } });
    assert.equal(events.length, 4);
    assert(events.some(e => e.snapshot.action === 'file.upload'));
    assert(events.some(e => e.event === 'UPDATE' && e.snapshot.result.message === 'done'));
    await db.sambaOperation.delete({ where: { id: `${prefix}-m` } });
    assert.equal((await service.audit()).valid, true);
    // Failed/rolled-back writes cannot leave a phantom ledger tail.
    await assert.rejects(() => db.$transaction(async tx => {
      await tx.sambaOperation.create({ data: data('rollback') });
      throw Error('simulate rollback');
    }));
    assert.equal(await db.sambaAuditEvent.count({ where: { operationId: `${prefix}-rollback` } }), 0);
    assert.equal((await service.audit()).valid, true);
  });
  test('ledger rewrites are rejected and unrecorded changes to live state are detected', async () => {
    const op = await db.sambaOperation.create({ data: data('tamper') });
    const event = await db.sambaAuditEvent.findFirstOrThrow({ where: { operationId: op.id } });
    await assert.rejects(() => db.sambaAuditEvent.update({ where: { sequence: event.sequence }, data: { snapshot: {} } }), /append-only/);
    await assert.rejects(() => db.sambaAuditEvent.delete({ where: { sequence: event.sequence } }), /append-only/);
    // Only the isolated test database owner can simulate a bypassed capture trigger.
    // SET LOCAL is scoped to this transaction/connection; other test writers are unaffected.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.sambaOperation.update({ where: { id: op.id }, data: { actorName: 'forged', action: 'user.password', metadata: { target: 'another' }, result: { forged: true } } });
      const audit = new SambaService(tx);
      const check = await audit.audit();
      assert.equal(check.valid, false);
      assert.equal(check.brokenAt, op.id);
      // Restore the originally recorded state inside the same isolated transaction.
      await tx.sambaOperation.update({ where: { id: op.id }, data: { actorName: op.actorName, action: op.action, metadata: op.metadata, result: require('@prisma/client').Prisma.DbNull } });
    });
    assert.equal((await service.audit()).valid, true);
  });
}
