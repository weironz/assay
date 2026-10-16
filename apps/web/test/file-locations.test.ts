import { expect, test } from "bun:test";
import { fileHref, fileLocation } from "../src/features/files/locations";

test("folder bookmarks preserve Unicode, spaces and URL delimiters without changing the share", () => {
  const share = "team & design";
  const path = "资料/报价 #1+2.pdf";
  const href = fileHref(share, path);
  expect(
    fileLocation(new URL(href, "https://assay.example").searchParams, [share]),
  ).toEqual({ share, path });
});

test("a bookmarked share cannot bypass the current account catalog", () => {
  const params = new URLSearchParams("share=finance&path=payroll");
  expect(fileLocation(params, ["common", "thailand"])).toEqual({
    share: "",
    path: "",
  });
  expect(fileLocation(params, [])).toEqual({ share: "", path: "" });
});

test("unsafe or nonrelative bookmark paths cannot reach file operations", () => {
  for (const path of [
    "../secret",
    "/etc",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "a\0b",
    "a\nb",
    "a".repeat(4097),
  ]) {
    expect(
      fileLocation(new URLSearchParams({ share: "common", path }), ["common"]),
    ).toEqual({ share: "", path: "" });
  }
});

test("root bookmarks open the authorized directory and ignore unrelated query parameters", () => {
  const params = new URLSearchParams(
    "share=common&redirect=https://example.invalid",
  );
  expect(fileLocation(params, ["common"])).toEqual({
    share: "common",
    path: "",
  });
  expect(fileLocation(new URLSearchParams(), ["common"])).toEqual({
    share: "",
    path: "",
  });
});
