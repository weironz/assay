// Every API is intercepted; proves legacy name URLs cannot strand a renamed share.
const assert = require("node:assert/strict"),
  { chromium } = require("playwright"),
  origin = require("./test-origin.cjs");
let browser;
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
            bypass: new URL(origin).hostname + ",localhost,127.0.0.1",
          },
        }
      : {}),
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("i18nextLng", "zh-CN"));
  const share = {
    id: "c".repeat(32),
    revision: "a".repeat(64),
    name: "legacy_share",
    comment: "Fixture",
    groups: [],
    active: true,
    ready: true,
    read_only: false,
    path: "original_data",
    browseable: true,
  };
  let writes = 0;
  await ctx.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    let status = 200,
      data = {};
    if (p === "/api/me")
      data = {
        id: "admin-fixture",
        name: "Administrator",
        email: "admin@example.test",
        roles: ["admin"],
        permissions: ["samba:read", "samba:manage"],
        status: "ACTIVE",
      };
    else if (p === "/api/modules") data = { directory: true, files: true };
    else if (p === "/api/notifications/unread-count") data = { count: 0 };
    else if (p === "/api/samba/snapshot")
      data = {
        enabled: true,
        domain: "DC=example,DC=test",
        groupPrefix: "",
        readOnly: false,
        renameEnabled: true,
        users: [],
        groups: [],
        shares: [share],
        bindings: [],
        assayUsers: [],
      };
    else if (p === "/api/me/security")
      data = {
        privileged: true,
        enrolled: false,
        privilegedMfaMode: "optional",
        stepUpExemptPurposes: ["samba"],
      };
    else if (p === "/api/samba/directories") data = { directories: [] };
    else if (p === "/api/samba/acl")
      data = { revision: "b".repeat(64), owner: "S-1-5-18", entries: [] };
    else if (p === "/api/samba/rename-preview") {
      const body = request.postDataJSON();
      assert.equal(body.id, share.id);
      assert.equal(body.revision, share.revision);
      data = {
        oldName: share.name,
        newName: body.name,
        oldAddress: "\\\\fileserver\\" + share.name,
        newAddress: "\\\\fileserver\\" + body.name,
        activeSmbConnections: 1,
        affectedShares: [{ name: body.name, path: "/data/original_data" }],
        validatedConfig: true,
      };
    } else if (p === "/api/samba/commands") {
      const body = request.postDataJSON();
      assert.equal(body.action, "share.rename");
      assert.equal(body.args.id, share.id);
      assert.equal(body.args.name, "renamed_share");
      assert.equal(body.args.acknowledge_connections, true);
      writes++;
      share.name = body.args.name;
      data = { id: body.requestId, state: "succeeded" };
      status = 201;
    } else if (request.method() !== "GET") throw Error("Unexpected write " + p);
    await route.fulfill({ status, json: data });
  });
  const page = await ctx.newPage();
  await page.goto(origin + "/samba/shares/legacy_share");
  await page.waitForURL("**/samba/shares/" + share.id);
  await page
    .getByRole("heading", { name: "legacy_share", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "重命名共享", exact: true }).click();
  const d = page.getByRole("dialog", { name: "重命名共享", exact: true });
  await d.getByRole("textbox", { name: "新名称" }).fill("renamed_share");
  await d.getByRole("button", { name: "预检查", exact: true }).click();
  await d
    .getByText("实际文件目录不移动：/data/original_data", { exact: true })
    .waitFor();
  assert.equal(writes, 0);
  assert(
    await d
      .getByRole("button", { name: "确认重命名", exact: true })
      .isDisabled(),
  );
  await d.getByRole("checkbox").check();
  await d.getByRole("button", { name: "确认重命名", exact: true }).click();
  await page
    .getByRole("heading", { name: "renamed_share", exact: true })
    .waitFor();
  assert.equal(writes, 1);
  assert.equal(new URL(page.url()).pathname, "/samba/shares/" + share.id);
  await page.getByText("original_data", { exact: true }).waitFor();
  console.log(
    "PASS legacy share URL canonicalizes to stable ID before rename; details and physical path survive exactly one confirmed write",
  );
  await ctx.close();
})()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
  });
