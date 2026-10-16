// Explicit deployment and root-private credential fixtures only; generated qa_ objects only.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync, spawn } = require("node:child_process"),
  { randomBytes, randomUUID, createHash } = require("node:crypto");
const { chromium } = require("playwright");
const origin = require("./test-origin.cjs");
const dir = process.env.SAMBA_E2E_PRIVATE_DIR;
assert(dir, "Set a private fixture directory");
const f = JSON.parse(
  fs.readFileSync(path.join(dir, "rename-control.json"), "utf8"),
);
assert.equal(f.origin, origin);
const tag = randomBytes(5).toString("hex"),
  names = {
    user: "qa_rename_u_" + tag,
    denied: "qa_rename_d_" + tag,
    group: "qa_rename_g_" + tag,
    share: "qa_rename_s_" + tag,
  };
const owned = {
  names,
  password: "Aa9!" + randomBytes(20).toString("base64url"),
  ids: {},
  operations: [],
  createdAt: new Date().toISOString(),
};
const save = () =>
  fs.writeFileSync(
    path.join(dir, "rename-owned.json"),
    JSON.stringify(owned, null, 2),
    { mode: 0o600 },
  );
save();
let browser, admin, employee, denied, holding;
const results = [];
const pass = (x) => {
  results.push(x);
  console.log("PASS " + x);
};
async function api(ctx, route, method = "GET", data, status = 200) {
  const r = await ctx.request.fetch(origin + "/api" + route, {
    method,
    headers: { Origin: origin },
    ...(data ? { data } : {}),
  });
  assert.equal(r.status(), status, "Unexpected HTTP status for " + route);
  return r.json();
}
async function command(action, args) {
  const requestId = randomUUID();
  owned.operations.push(requestId);
  save();
  const r = await api(
    admin,
    "/samba/commands",
    "POST",
    { requestId, action, args },
    201,
  );
  for (let i = 0; i < 120; i++) {
    const op = await api(admin, "/samba/operations/" + r.id);
    if (op.state === "succeeded") return { requestId, op };
    assert(
      ["pending", "queued", "running"].includes(op.state),
      "Operation failed; inspect exact request ID " + requestId,
    );
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Operation still pending; do not replay");
}
async function snapshot() {
  return api(admin, "/samba/snapshot");
}
function probe(mode, name, share, extra = {}) {
  const input = {
    mode,
    name,
    share,
    domain: f.domain,
    server: f.smbServer,
    port: f.smbPort,
    password: owned.password,
    ...extra,
  };
  const r = spawnSync(
    process.env.SAMBA_SMB_PYTHON || "python3",
    [path.join(__dirname, "rename-smb-probe.py")],
    { input: JSON.stringify(input) + "\n", encoding: "utf8" },
  );
  const lines = r.stdout.trim().split("\n");
  let result;
  try {
    result = JSON.parse(lines.at(-1));
  } catch {
    throw Error("Independent SMB probe failed");
  }
  return result;
}
const invariant = (row) =>
  Object.fromEntries(
    [
      "id",
      "sid",
      "dn",
      "uidNumber",
      "gidNumber",
      "accountControl",
      "passwordChangedAt",
      "primaryGroupId",
      "groupType",
      "displayName",
      "description",
      "disabled",
      "members",
    ].map((k) => [k, row[k]]),
  );
async function login(ctx, name) {
  const r = await api(ctx, "/auth/sign-in/unified", "POST", {
    username: name,
    password: owned.password,
  });
  assert(!r.twoFactorRedirect);
  return api(ctx, "/me");
}
async function rename(kind, row, name) {
  const current = await snapshot();
  row = current[{ user: "users", group: "groups", share: "shares" }[kind]].find(
    (item) => item.id === row.id,
  );
  assert(row);
  const args = {
    kind,
    id: row.id,
    name,
    revision: row.revision,
    acknowledge_connections: true,
  };
  const preview = await api(admin, "/samba/rename-preview", "POST", args);
  assert(
    preview.validatedConfig &&
      preview.physicalPathUnchanged &&
      preview.cnDnUnchanged,
  );
  const page = await admin.newPage();
  await page.addInitScript(() => localStorage.setItem("i18nextLng", "zh-CN"));
  await page.goto(
    origin +
      "/samba/" +
      { user: "users", group: "groups", share: "shares" }[kind] +
      "/" +
      row.id,
  );
  const title = {
    user: "重命名登录账号",
    group: "重命名用户组",
    share: "重命名共享",
  }[kind];
  await page.getByRole("button", { name: title, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("textbox", { name: "新名称" }).fill(name);
  await dialog.getByRole("button", { name: "预检查", exact: true }).click();
  await dialog.getByText(/配置验证已通过/).waitFor();
  assert(
    await dialog
      .getByRole("button", { name: "确认重命名", exact: true })
      .isDisabled(),
  );
  await dialog.getByRole("checkbox").check();
  if (kind === "share") {
    await dialog
      .getByText("旧共享地址：" + preview.oldAddress, { exact: true })
      .waitFor();
    await dialog
      .getByText("新共享地址：" + preview.newAddress, { exact: true })
      .waitFor();
  }
  await page.screenshot({
    path: path.join(dir, "rename-preview-" + kind + ".png"),
    fullPage: true,
  });
  const sent = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/samba/commands" &&
      r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "确认重命名", exact: true }).click();
  const response = await sent;
  assert.equal(response.status(), 201);
  const submitted = response.request().postDataJSON();
  assert.deepEqual(submitted.args, args);
  const operation = await response.json();
  owned.operations.push(operation.id);
  save();
  let done = false;
  for (let i = 0; i < 120; i++) {
    const op = await api(admin, "/samba/operations/" + operation.id);
    if (op.state === "succeeded") {
      done = true;
      break;
    }
    assert(
      ["queued", "pending", "running"].includes(op.state),
      "Browser rename failed; inspect operation " + operation.id,
    );
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(done, "Browser operation timed out");
  await page.getByText("操作已完成", { exact: true }).waitFor();
  await page.close();
  return args;
}
(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(process.env.HTTPS_PROXY
      ? {
          proxy: {
            server: process.env.HTTPS_PROXY,
            bypass: new URL(origin).hostname + ",127.0.0.1,localhost",
          },
        }
      : {}),
  });
  admin = await browser.newContext({ ignoreHTTPSErrors: true });
  employee = await browser.newContext({ ignoreHTTPSErrors: true });
  denied = await browser.newContext({ ignoreHTTPSErrors: true });
  await api(admin, "/auth/sign-in/unified", "POST", {
    username: f.adminEmail,
    password: f.adminPassword,
  });
  const initial = await snapshot();
  assert(initial.renameEnabled);
  owned.originalGroups = initial.groups.map((g) => g.id);
  owned.originalUsers = initial.users.map((u) => u.id);
  owned.originalShares = initial.shares.map((s) => s.id);
  save();
  for (const key of ["user", "denied"]) {
    const r = await command("user.create", {
      name: names[key],
      display_name: "Rename QA " + key,
      password: owned.password,
    });
    owned.ids[key] = r.op.result.result.id;
    save();
  }
  let r = await command("group.create", {
    name: names.group,
    description: "Owned rename acceptance " + tag,
  });
  owned.ids.group = r.op.result.result.id;
  save();
  await command("group.members", {
    group_id: owned.ids.group,
    user_ids: [owned.ids.user],
    add: true,
  });
  await command("share.save", {
    name: names.share,
    comment: "Owned rename acceptance " + tag,
    groups: [owned.ids.group],
    read_only: false,
  });
  let state = await snapshot(),
    user = state.users.find((u) => u.id === owned.ids.user),
    group = state.groups.find((g) => g.id === owned.ids.group),
    share = state.shares.find((s) => s.name === names.share);
  owned.ids.share = share.id;
  save();
  await api(
    admin,
    "/directory/mappings",
    "POST",
    { groupSid: group.sid, roleName: "requester" },
    201,
  );
  const beforeUser = invariant(user),
    beforeGroup = invariant(group),
    acl = await api(
      admin,
      "/samba/acl?" + new URLSearchParams({ share: share.name, path: "" }),
    );
  for (const [kind, row, name, code] of [
    ["user", user, "../invalid", "RENAME_INVALID_NAME"],
    ["user", user, group.name, "RENAME_NAME_EXISTS"],
    ["group", group, names.denied, "RENAME_NAME_EXISTS"],
    ["share", share, "scan", "RENAME_PROTECTED"],
  ]) {
    const rejected = await api(
      admin,
      "/samba/rename-preview",
      "POST",
      { kind, id: row.id, name, revision: row.revision },
      400,
    );
    assert.equal(rejected.code, code);
  }
  const me = await login(employee, user.name);
  owned.assayUserId = me.id;
  save();
  assert(me.roles.includes("requester"));
  await login(denied, names.denied);
  await api(
    denied,
    "/samba/rename-preview",
    "POST",
    {
      kind: "user",
      id: user.id,
      name: user.name + "_x",
      revision: user.revision,
    },
    403,
  );
  assert.equal(
    probe("read", names.denied, share.name).error,
    "STATUS_ACCESS_DENIED",
  );
  const data = randomBytes(1024);
  owned.probe = {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
    physicalDirectory: names.share,
    file: "rename-probe.txt",
  };
  save();
  assert(
    probe("write", user.name, share.name, { data: data.toString("base64") })
      .ok !== false,
  );
  const original = probe("read", user.name, share.name);
  assert(original.ok);
  pass(
    "Fresh SMB sessions admit only the authorized QA employee; requester has no rename permission",
  );
  const newUser = user.name + "_new";
  await rename("user", user, newUser);
  state = await snapshot();
  user = state.users.find((u) => u.id === owned.ids.user);
  assert.deepEqual(invariant(user), beforeUser);
  assert.equal(user.upn, newUser + "@" + f.directoryDomain);
  await api(employee, "/auth/sign-out", "POST", {});
  const renamedMe = await login(employee, newUser);
  assert.equal(renamedMe.id, me.id);
  assert.deepEqual(renamedMe.roles, me.roles);
  assert.deepEqual(probe("read", newUser, share.name), original);
  assert.equal(
    probe("read", names.user, share.name).error,
    "STATUS_LOGON_FAILURE",
  );
  pass(
    "Account rename retains GUID/SID/numeric IDs/password timestamp/CN/DN/roles and Assay User.id; original password authenticates the new name",
  );
  const newGroup = group.name + "_new";
  assert.equal((await api(employee, "/files/status")).connected, true);
  await rename("group", group, newGroup);
  state = await snapshot();
  group = state.groups.find((g) => g.id === owned.ids.group);
  share = state.shares.find((s) => s.id === owned.ids.share);
  assert.deepEqual(invariant(group), beforeGroup);
  assert.deepEqual(share.groups, [newGroup]);
  assert.equal(
    (await api(employee, "/files/status")).connected,
    true,
    "Group label changes must retain a live SMB capability with the same SID policy",
  );
  assert.equal(
    (await api(admin, "/directory/settings")).mappings.find(
      (m) => m.groupSid === group.sid,
    ).groupName,
    newGroup,
  );
  assert.equal(
    (
      await api(
        admin,
        "/samba/acl?" + new URLSearchParams({ share: share.name, path: "" }),
      )
    ).revision,
    acl.revision,
  );
  assert.deepEqual(probe("read", newUser, share.name), original);
  assert.equal(
    probe("read", names.denied, share.name).error,
    "STATUS_ACCESS_DENIED",
  );
  pass(
    "Group rename keeps SID/member links/role mapping and root ACL; SMB allow/deny decisions remain unchanged",
  );
  const heldInput = {
    mode: "hold",
    name: newUser,
    share: share.name,
    domain: f.domain,
    server: f.smbServer,
    port: f.smbPort,
    password: owned.password,
  };
  holding = spawn(
    process.env.SAMBA_SMB_PYTHON || "python3",
    [path.join(__dirname, "rename-smb-probe.py")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  holding.stdout.on("data", (b) => (output += b));
  holding.stdin.write(JSON.stringify(heldInput) + "\n");
  for (let i = 0; i < 100 && !output.includes('"ready": true'); i++)
    await new Promise((r) => setTimeout(r, 100));
  assert(output.includes('"ready": true'), "Cannot hold QA file handle");
  const newShare = share.name + "_new",
    args = await rename("share", share, newShare);
  state = await snapshot();
  const current = state.shares.find((s) => s.id === share.id);
  assert.equal(current.path, share.path || share.name);
  assert.equal(current.name, newShare);
  assert.equal(current.read_only, share.read_only);
  assert.equal(current.browseable, share.browseable);
  holding.stdin.end("\n");
  const exit = await new Promise((resolve) => holding.on("close", resolve));
  assert.equal(exit, 0);
  assert(JSON.parse(output.trim().split("\n").at(-1)).ok);
  holding = null;
  assert.deepEqual(probe("read", newUser, newShare), original);
  assert(
    [
      "STATUS_BAD_NETWORK_NAME",
      "STATUS_NOT_FOUND",
      "STATUS_OBJECT_PATH_NOT_FOUND",
    ].includes(probe("list", newUser, share.name).error),
    "Old share root must not exist for a fresh SMB connection",
  );
  assert.equal(
    (
      await api(
        admin,
        "/samba/acl?" + new URLSearchParams({ share: newShare, path: "" }),
      )
    ).revision,
    acl.revision,
  );
  const replay = await api(
    admin,
    "/samba/commands",
    "POST",
    { requestId: owned.operations.at(-1), action: "share.rename", args },
    201,
  );
  assert.equal(replay.state, "succeeded");
  const staleId = randomUUID();
  owned.operations.push(staleId);
  save();
  await api(
    admin,
    "/samba/commands",
    "POST",
    {
      requestId: staleId,
      action: "share.rename",
      args: { ...args, name: newShare + "_other" },
    },
    201,
  );
  let failed;
  for (let i = 0; i < 100; i++) {
    failed = await api(admin, "/samba/operations/" + staleId);
    if (!["queued", "pending", "running"].includes(failed.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(failed.state, "failed");
  assert.equal(failed.result.error_code, "RENAME_CONFLICT");
  await api(employee, "/auth/sign-out", "POST", {});
  await login(employee, newUser);
  const newFiles = await api(employee, "/files/status");
  assert(newFiles.shares.includes(newShare));
  assert(!newFiles.shares.includes(share.name));
  assert(
    (
      await api(
        employee,
        "/files/list?" + new URLSearchParams({ share: newShare, path: "" }),
      )
    ).entries.some((e) => e.name === "rename-probe.txt"),
  );
  pass(
    "Share rename retains inode/content/root ACL/physical directory and an open file handle; new connections reject the old UNC name; successful retry is idempotent",
  );
  assert.equal(probe("delete", newUser, newShare).ok, true);
  owned.probeRemoved = true;
  save();
  fs.writeFileSync(
    path.join(dir, "rename-result.json"),
    JSON.stringify(
      {
        passed: results.length,
        results,
        ownedIds: owned.ids,
        assayUserId: me.id,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
})()
  .catch((e) => {
    let message = e.message;
    for (const secret of [f.adminPassword, owned.password])
      message = message.replaceAll(secret, "[redacted]");
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    holding?.kill();
    for (const ctx of [employee, denied, admin])
      if (ctx) await api(ctx, "/auth/sign-out", "POST", {}).catch(() => {});
    await browser?.close();
  });
