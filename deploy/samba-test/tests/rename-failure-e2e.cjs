// Run only against the disposable ASSAY.TEST loopback deployment, after an
// operator has installed either a read-only config-file mount or a low-privilege
// LDAP binding. Fault injection never exists in the production Agent binary.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");
const origin = require("./test-origin.cjs");
const dir = process.env.SAMBA_E2E_PRIVATE_DIR,
  expected = process.env.SAMBA_RENAME_EXPECTED_FAILURE;
assert(["RENAME_ROLLED_BACK", "AD_PERMISSION_DENIED"].includes(expected));
assert.equal(new URL(origin).hostname, "127.0.0.1");
const f = JSON.parse(
    fs.readFileSync(path.join(dir, "rename-control.json"), "utf8"),
  ),
  owned = JSON.parse(
    fs.readFileSync(path.join(dir, "rename-owned.json"), "utf8"),
  );
assert.equal(f.directoryDomain, "assay.test");
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
  await api("/auth/sign-in/unified", "POST", {
    username: f.adminEmail,
    password: f.adminPassword,
  });
  const snapshot = await api("/samba/snapshot");
  assert.equal(snapshot.domain.toLowerCase(), "dc=assay,dc=test");
  const user = snapshot.users.find((u) => u.id === owned.ids.user);
  assert(user?.name.startsWith("qa_rename_"));
  const args = {
    kind: "user",
    id: user.id,
    name: user.name + "_rollback",
    revision: user.revision,
    acknowledge_connections: true,
  };
  assert((await api("/samba/rename-preview", "POST", args)).validatedConfig);
  const requestId = randomUUID();
  await api(
    "/samba/commands",
    "POST",
    { requestId, action: "user.rename", args },
    201,
  );
  let op;
  for (let n = 0; n < 150; n++) {
    op = await api("/samba/operations/" + requestId);
    if (!["queued", "running", "pending"].includes(op.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(op.state, "failed");
  assert.equal(op.result.error_code, expected);
  const after = await api("/samba/snapshot"),
    current = after.users.find((u) => u.id === user.id);
  for (const key of [
    "id",
    "sid",
    "dn",
    "name",
    "upn",
    "uidNumber",
    "gidNumber",
    "accountControl",
    "passwordChangedAt",
    "primaryGroupId",
    "displayName",
    "members",
  ])
    assert.deepEqual(current[key], user[key], key + " changed after failure");
  const normalized = (rows) => rows.map(({ revision, ...v }) => v);
  assert.deepEqual(normalized(after.shares), normalized(snapshot.shares));
  assert.deepEqual(normalized(after.groups), normalized(snapshot.groups));
  // A fresh session with the original password must still resolve the same user.
  const employee = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = await employee.request.post(
    origin + "/api/auth/sign-in/unified",
    {
      headers: { Origin: origin },
      data: { username: user.name, password: owned.password },
    },
  );
  assert.equal(login.status(), 200);
  const me = await employee.request.get(origin + "/api/me");
  assert.equal((await me.json()).id, owned.assayUserId);
  await employee.request.post(origin + "/api/auth/sign-out", {
    headers: { Origin: origin },
    data: {},
  });
  await employee.close();
  fs.writeFileSync(
    path.join(dir, "rename-failure-" + expected + ".json"),
    JSON.stringify(
      {
        expected,
        operationId: requestId,
        identityPreserved: true,
        configurationPreserved: true,
        originalPasswordStillValid: true,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "PASS " +
      expected +
      ": original identity, names, configuration and password preserved",
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
