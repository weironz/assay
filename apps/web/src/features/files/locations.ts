import type { FileLocation } from "./storage";

export function fileHref(share: string, path = "") {
  const params = new URLSearchParams({ share });
  if (path) params.set("path", path);
  return "/files?" + params.toString();
}

/** A bookmark never grants access: resolve only against the current user's catalog. */
export function fileLocation(
  params: URLSearchParams,
  allowedShares: string[],
): FileLocation {
  const share = params.get("share") || "";
  const path = params.get("path") || "";
  if (
    !allowedShares.includes(share) ||
    path.length > 4096 ||
    /[\\\x00-\x1f]/.test(path) ||
    (path && path.split("/").some((p) => !p || p === "." || p === ".."))
  )
    return { share: "", path: "" };
  return { share, path };
}
