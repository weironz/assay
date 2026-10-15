import type { PrismaClient } from "@prisma/client";
import type { DirectorySettings } from "./directory-config";

export class LoginRejected extends Error {}
export class LoginDirectoryUnavailable extends Error {}
export const registrationEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.AUTH_ALLOW_REGISTRATION === "true";
export const publicRegistrationBlocked = (
  enabled: boolean,
  ctx: { request?: unknown; headers?: unknown },
) => !enabled && !!(ctx.request || ctx.headers);

export type LoginRoute =
  | { source: "local"; email: string }
  | { source: "directory"; username: string; objectId?: string };
/** Resolve authority before checking any password. Never authenticate against two authorities. */
export async function resolveLoginRoute(
  db: Pick<PrismaClient, "user" | "directoryIdentity">,
  input: string,
  settings: DirectorySettings | null,
  emergency = false,
): Promise<LoginRoute> {
  const name = input.trim();
  if (!name || name.length > 254 || /[\x00-\x1f\x7f]/.test(name))
    throw new LoginRejected();
  const users = await db.user.findMany({
    where: {
      OR: [
        { email: { equals: name, mode: "insensitive" } },
        { username: { equals: name, mode: "insensitive" } },
      ],
    },
    take: 2,
    include: {
      directoryIdentity: true,
      accounts: {
        where: { providerId: "credential", password: { not: null } },
        select: { id: true },
      },
      roles: { include: { role: true } },
    },
  });
  if (users.length > 1) throw new LoginRejected();
  const user = users[0];
  // Emergency access is reserved for independent local administrators. An inactive
  // retained local hash on a directory-managed identity never becomes a fallback.
  if (emergency) {
    if (
      !user ||
      user.status !== "ACTIVE" ||
      user.directoryIdentity ||
      !user.accounts.length ||
      !user.roles.some((r) => r.role.name === "admin")
    )
      throw new LoginRejected();
    return { source: "local", email: user.email };
  }
  let alias = name;
  if (settings && name.includes("\\")) {
    const parts = name.split("\\");
    if (
      parts.length !== 2 ||
      ![settings.domain, settings.sambaDomain.toLowerCase()].includes(
        parts[0].toLowerCase(),
      )
    )
      throw new LoginRejected();
    alias = parts[1];
  }
  const identities =
    settings && !alias.includes("@")
      ? await db.directoryIdentity.findMany({
          where: {
            providerId: settings.providerId,
            accountName: { equals: alias, mode: "insensitive" },
          },
          take: 2,
        })
      : [];
  if (
    identities.length > 1 ||
    (user && identities[0] && identities[0].userId !== user.id)
  )
    throw new LoginRejected();
  const identity = user?.directoryIdentity || identities[0];
  if (identity) {
    // Disabling the integration is an explicit deployment choice, distinct from
    // an AD outage or password rejection. Preserve standalone local credentials.
    if (!settings && user?.status === 'ACTIVE' && user.accounts.length)
      return { source: 'local', email: user.email };
    if (!settings || identity.providerId !== settings.providerId)
      throw new LoginDirectoryUnavailable();
    return {
      source: "directory",
      username: identity.accountName,
      objectId: identity.objectId,
    };
  }
  if (user) {
    if (user.status !== "ACTIVE" || !user.accounts.length)
      throw new LoginRejected();
    return { source: "local", email: user.email };
  }
  if (settings) return { source: "directory", username: name };
  throw new LoginRejected();
}
