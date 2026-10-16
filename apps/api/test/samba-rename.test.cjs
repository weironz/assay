const { test } = require("node:test");
const assert = require("node:assert/strict");
const { actions, renameSchema } = require("../src/samba/contracts");
const { SambaService } = require("../src/samba/samba.service");
const id = "a".repeat(32),
  revision = "b".repeat(64);
test("rename contracts require a stable GUID, version and matching action without credential or path fields", () => {
  for (const kind of ["user", "group", "share"]) {
    const valid = {
      kind,
      id,
      name: "project_group",
      revision,
      acknowledge_connections: true,
    };
    assert(actions[kind + ".rename"].safeParse(valid).success);
    for (const bad of [
      { ...valid, id: undefined },
      { ...valid, revision: undefined },
      { ...valid, name: "../escape" },
      { ...valid, password: "forbidden" },
      { ...valid, path: "/etc" },
      { ...valid, kind: "other" },
    ])
      assert(!actions[kind + ".rename"].safeParse(bad).success);
  }
  assert.equal(
    renameSchema.parse({
      kind: "user",
      id: id.toUpperCase(),
      name: "new_login",
      revision,
    }).id,
    id,
  );
});
test("confirmed account rename updates only labels on existing GUID bindings and clears only that profile cache", async () => {
  const op = {
    id: "operation",
    action: "user.rename",
    metadata: { kind: "user", id, name: "new_login" },
  };
  const calls = [];
  const tx = {
    sambaIdentity: {
      findMany: async () => [
        { userId: "original-user", domain: "dc=example, DC=test" },
        { userId: "other-domain", domain: "DC=other,DC=test" },
      ],
      updateMany: async (q) => calls.push(["samba", q]),
    },
    directoryIdentity: {
      updateMany: async (q) => calls.push(["directory", q]),
    },
    sambaOperation: { update: async (q) => q.data },
  };
  const service = new SambaService({
    sambaOperation: { findUnique: async () => op },
    $transaction: async (cb) => cb(tx),
  });
  service.invalidateRenameProfile = async (providerId, objectId) =>
    calls.push(["cache", { providerId, objectId }]);
  const result = await service.recordResult(op.id, {
    state: "succeeded",
    result: {
      kind: "user",
      id,
      newName: "new_login",
      domain: "DC=example,DC=test",
    },
  });
  assert.equal(result.state, "succeeded");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1][1], {
    where: {
      userId: { in: ["original-user"] },
      adObjectId: id,
    },
    data: { accountName: "new_login" },
  });
  assert.deepEqual(calls[2][1].where, {
    objectId: id,
    providerId: "ad:example.test",
  });
  assert.equal(calls[2][1].data.accountName, "new_login");
  assert.deepEqual(calls[0][1], {
    providerId: "ad:example.test",
    objectId: id,
  });
  // Same verified outcome can be reconciled again after API restart without creating a user.
  await service.recordResult(op.id, {
    state: "succeeded",
    result: {
      kind: "user",
      id,
      newName: "new_login",
      domain: "DC=example,DC=test",
    },
  });
  assert.equal(calls.length, 6);
});
test("group rename retains SID-based role mappings and rejects mismatched Agent outcomes before mutation", async () => {
  const op = {
      id: "operation",
      action: "group.rename",
      metadata: { kind: "group", id, name: "project_group" },
    },
    calls = [];
  const service = new SambaService({
    sambaOperation: { findUnique: async () => op },
    $transaction: async (cb) =>
      cb({
        directoryGroupRole: { updateMany: async (q) => calls.push(q) },
        sambaOperation: { update: async (q) => q.data },
      }),
  });
  await assert.rejects(
    service.recordResult(op.id, {
      state: "succeeded",
      result: {
        kind: "group",
        id: "c".repeat(32),
        newName: "project_group",
        domain: "DC=example,DC=test",
      },
    }),
  );
  assert.equal(calls.length, 0);
  await service.recordResult(op.id, {
    state: "succeeded",
    result: {
      kind: "group",
      id,
      newName: "project_group",
      domain: "DC=example,DC=test",
      sid: "S-1-5-21-1-2-3-1001",
    },
  });
  assert.deepEqual(calls, [
    {
      where: { providerId: "ad:example.test", groupSid: "S-1-5-21-1-2-3-1001" },
      data: { groupName: "project_group" },
    },
  ]);
});
test("renaming a group label keeps the employee file admission policy stable by SID", async () => {
  const link = { adObjectId: id, domain: "DC=example,DC=test" };
  const data = {
    domain: link.domain,
    users: [{ id, name: "employee", disabled: false, manageable: true }],
    groups: [{ name: "old_group", sid: "S-1-5-21-1-2-3-1001" }],
    shares: [
      {
        name: "common",
        active: true,
        ready: true,
        groups: ["old_group"],
        read_only: false,
      },
    ],
  };
  const service = new SambaService({
    sambaIdentity: { findUnique: async () => link },
  });
  service.agent = async () => data;
  const before = await service.fileIdentity({ id: "employee" });
  data.groups[0].name = "new_group";
  data.shares[0].groups = ["new_group"];
  assert.deepEqual(
    (await service.fileIdentity({ id: "employee" })).sharePolicies,
    before.sharePolicies,
  );
  data.groups[0].sid = "S-1-5-21-1-2-3-1002";
  assert.notDeepEqual(
    (await service.fileIdentity({ id: "employee" })).sharePolicies,
    before.sharePolicies,
  );
});
