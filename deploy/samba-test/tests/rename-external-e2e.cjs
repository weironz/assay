// Pre-imported, disposable qa_ business share only. Never selects company data implicitly.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process"),
  { randomUUID } = require("node:crypto");
const { chromium } = require("playwright"),
  origin = require("./test-origin.cjs"),
  dir = process.env.SAMBA_E2E_PRIVATE_DIR;
const f = JSON.parse(
    fs.readFileSync(path.join(dir, "rename-control.json"), "utf8"),
  ),
  owned = JSON.parse(
    fs.readFileSync(
      path.join(
        dir,
        fs.existsSync(path.join(dir, "rename-external-owned.json"))
          ? "rename-external-owned.json"
          : "rename-owned.json",
      ),
      "utf8",
    ),
  );
assert.equal(f.directoryDomain, "assay.test");
assert.equal(new URL(origin).hostname, "127.0.0.1");
let browser, ctx;
async function api(route, method = "GET", data, status = 200) {
  const r = await ctx.request.fetch(origin + "/api" + route, {
    method,
    headers: { Origin: origin },
    ...(data ? { data } : {}),
  });
  assert.equal(r.status(), status, "HTTP failure for " + route);
  return r.json();
}
async function rename(kind, row, name) {
  const args = {
    kind,
    id: row.id,
    name,
    revision: row.revision,
    acknowledge_connections: true,
  };
  assert((await api("/samba/rename-preview", "POST", args)).validatedConfig);
  const requestId = randomUUID();
  await api(
    "/samba/commands",
    "POST",
    { requestId, action: kind + ".rename", args },
    201,
  );
  for (let i = 0; i < 100; i++) {
    const op = await api("/samba/operations/" + requestId);
    if (op.state === "succeeded") return;
    assert(
      ["queued", "pending", "running"].includes(op.state),
      "External rename failed; inspect " + requestId,
    );
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Operation not confirmed");
}
function probe(mode, user, share) {
  const r = spawnSync(
    process.env.SAMBA_SMB_PYTHON || "python3",
    [path.join(__dirname, "rename-smb-probe.py")],
    {
      input:
        JSON.stringify({
          mode,
          name: user.name,
          share: share.name,
          password: owned.password,
          domain: f.domain,
          server: f.smbServer,
          port: f.smbPort,
        }) + "\n",
      encoding: "utf8",
    },
  );
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(process.env.HTTPS_PROXY
      ? {
          proxy: {
            server: process.env.HTTPS_PROXY,
            bypass: "127.0.0.1,localhost",
          },
        }
      : {}),
  });
  ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("i18nextLng", "zh-CN"));
  await api("/auth/sign-in/unified", "POST", {
    username: f.adminEmail,
    password: f.adminPassword,
  });
  let data = await api("/samba/snapshot");
  assert.equal(data.domain.toLowerCase(), "dc=assay,dc=test");
  let share = data.shares.find(
    (s) => s.external && s.path === owned.names.share,
  );
  assert(share?.name.startsWith("qa_"));
  const original = { ...share };
  const user = data.users.find((u) => u.id === owned.ids.user),
    denied = data.users.find((u) => u.id === owned.ids.denied);
  let group = data.groups.find((g) => g.id === owned.ids.group);
  const oldGroup = { ...group };
  const restore = async () => {
    let current = await api("/samba/snapshot");
    let g = current.groups.find((g) => g.id === group.id);
    if (g.name !== owned.names.group + "_new")
      await rename("group", g, owned.names.group + "_new");
    current = await api("/samba/snapshot");
    let s = current.shares.find((s) => s.id === share.id);
    if (s.name !== owned.names.share + "_new")
      await rename("share", s, owned.names.share + "_new");
  };
  if (process.argv.includes("--restore-only")) {
    await restore();
    console.log("PASS external QA names restored by stable IDs");
    return;
  }
  assert.equal(share.name, owned.names.share + "_new");
  assert.equal(group.name, owned.names.group + "_new");
  assert(share.read_only && share.browseable === false);
  const before = probe("read", user, share);
  assert(before.ok);
  assert.equal(probe("read", denied, share).error, "STATUS_ACCESS_DENIED");
  const acl = await api(
    "/samba/acl?" + new URLSearchParams({ share: share.name, path: "" }),
  );
  const page = await ctx.newPage();
  await page.goto(origin + "/samba/shares/" + share.id);
  assert(
    await page
      .getByRole("button", { name: "重命名共享", exact: true })
      .isEnabled(),
  );
  await page.close();
  await rename("group", group, group.name + "_ext");
  data = await api("/samba/snapshot");
  group = data.groups.find((g) => g.id === oldGroup.id);
  share = data.shares.find((s) => s.id === original.id);
  assert.equal(group.sid, oldGroup.sid);
  assert.deepEqual(group.members, oldGroup.members);
  assert.deepEqual(share.groups, [group.name]);
  assert.deepEqual(probe("read", user, share), before);
  assert.equal(probe("read", denied, share).error, "STATUS_ACCESS_DENIED");
  await rename("share", share, share.name + "_ext");
  data = await api("/samba/snapshot");
  share = data.shares.find((s) => s.id === original.id);
  assert.equal(share.path, original.path);
  assert(share.read_only && share.browseable === false && share.external);
  assert.deepEqual(probe("read", user, share), before);
  assert(
    [
      "STATUS_BAD_NETWORK_NAME",
      "STATUS_NOT_FOUND",
      "STATUS_OBJECT_PATH_NOT_FOUND",
    ].includes(probe("list", user, original).error),
  );
  assert.equal(
    (
      await api(
        "/samba/acl?" + new URLSearchParams({ share: share.name, path: "" }),
      )
    ).revision,
    acl.revision,
  );
  // This fixture is intentionally read-only. Removing its marker is performed by
  // the fixture owner after checking the physical path, not by widening permissions.
  await restore();
  fs.writeFileSync(
    path.join(dir, "rename-external-result.json"),
    JSON.stringify(
      {
        passed: true,
        shareId: share.id,
        groupId: group.id,
        groupSid: group.sid,
        physicalPathUnchanged: true,
        inodesContentAndAclUnchanged: true,
        hiddenAndReadOnlyPreserved: true,
        unauthorizedEmployeeDenied: true,
        oldShareUnavailable: true,
        newShare: share.name,
        newGroup: group.name,
        qaNamesRestored: true,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "PASS imported external share and group rename: exact physical path, inode, content, ACL, hidden/read-only settings and allow/deny decisions preserved",
  );
})()
  .catch((e) => {
    console.error(
      e.message
        .replaceAll(f.adminPassword, "[redacted]")
        .replaceAll(owned.password, "[redacted]"),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (ctx) await api("/auth/sign-out", "POST", {}).catch(() => {});
    await browser?.close();
  });
