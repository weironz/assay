import { afterEach, expect, test } from "bun:test";
import { LoginError, unifiedSignIn } from "../src/lib/unified-login";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("a unified login sends one password request and never probes providers after rejection", async () => {
  const paths: string[] = [];
  globalThis.fetch = async (url, init) => {
    paths.push(String(url));
    expect(JSON.parse(String(init?.body)).username).toBe("alice");
    return Response.json(
      { code: "INVALID_EMAIL_OR_PASSWORD", message: "private diagnostic" },
      { status: 401 },
    );
  };
  await expect(
    unifiedSignIn("alice", "test-only-password", true),
  ).rejects.toBeInstanceOf(LoginError);
  expect(paths.length).toBe(1);
  expect(paths[0]).toEndWith("/sign-in/unified");
});
test("administrator recovery uses its dedicated endpoint while preserving MFA response and cookies", async () => {
  globalThis.fetch = async (url, init) => {
    expect(String(url)).toEndWith("/sign-in/local-admin");
    expect(init?.credentials).toBe("include");
    return Response.json({ twoFactorRedirect: true });
  };
  expect(
    await unifiedSignIn(
      "admin@example.test",
      "test-only-password",
      false,
      undefined,
      true,
    ),
  ).toEqual({ twoFactorRedirect: true });
});
test("login errors expose only safe classified codes", async () => {
  for (const [status, code, expected] of [
    [403, "DIRECTORY_LINK_REQUIRED", "DIRECTORY_LINK_REQUIRED"],
    [403, "EMAIL_NOT_VERIFIED", "EMAIL_NOT_VERIFIED"],
    [401, "DIRECTORY_LINK_REQUIRED", undefined],
    [500, "PRIVATE_ERROR", undefined],
  ] as const) {
    globalThis.fetch = async () =>
      Response.json({ code, message: "private diagnostic" }, { status });
    try {
      await unifiedSignIn("alice", "test-only-password", true);
      throw new Error("Expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(LoginError);
      expect((e as LoginError).code).toBe(expected);
      expect((e as Error).message).not.toContain("private");
    }
  }
});
