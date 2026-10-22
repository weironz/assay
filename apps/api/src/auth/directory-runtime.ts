import { createHash, randomUUID } from 'node:crypto';
import { APIError } from 'better-auth';
import type { PrismaClient } from '@prisma/client';
import { DirectoryClient, DirectoryRejected, DirectoryUnavailable, type DirectoryProfile } from './directory-client';
import { adDomainDN, normalizedDomainDN, readDirectorySettings } from './directory-config';
import { authRedis } from './auth-redis';
import type { SystemRoleName } from './role-policy';
import { directoryRolesForGroups } from './directory-role-policy';
import { getConfig } from '../config';

export const directorySettings = readDirectorySettings();
export const directoryClient = directorySettings ? new DirectoryClient(directorySettings) : null;
export class DirectoryLinkRequired extends Error {}
export type DirectorySession = { userId: string; providerId: string; objectId: string; securityStamp: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const directorySessionKey = (token: string) => `assay:directory:session:${hash(token)}`;
const profileKey = (id: string) => `assay:directory:profile:${hash(`${directorySettings?.providerId}:${id}`)}`;
export function directoryError(error: unknown): never {
  if (error instanceof DirectoryLinkRequired) throw new APIError('FORBIDDEN', { code: 'DIRECTORY_LINK_REQUIRED', message: '此公司账号已有文件访问关联，请由管理员在“身份与访问”中明确配置登录身份关联。' });
  if (error instanceof DirectoryUnavailable) throw new APIError('SERVICE_UNAVAILABLE', { code: 'DIRECTORY_UNAVAILABLE', message: '公司身份服务暂时不可用，请稍后重试' });
  throw new APIError('UNAUTHORIZED', { code: 'DIRECTORY_LOGIN_REJECTED', message: '公司账号登录失败，请核对凭据或联系管理员检查账号关联' });
}
export async function mappedDirectoryRoles(db: PrismaClient, groupSids: string[]): Promise<SystemRoleName[]> {
  if (!directorySettings) return [];
  const rows = await db.directoryGroupRole.findMany({ where: { providerId: directorySettings.providerId, groupSid: { in: groupSids } } });
  return directoryRolesForGroups(rows, groupSids);
}
export async function resolveDirectoryIdentity(db: PrismaClient, profile: DirectoryProfile, link?: { userId: string; actorId: string; actorName: string }) {
  const settings = directorySettings;
  if (!settings) throw new DirectoryRejected();
  const roleNames = await mappedDirectoryRoles(db, profile.groupSids);
  const user = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(73020261015::bigint) IS NULL AS locked`;
    const existing = await tx.directoryIdentity.findUnique({ where: { providerId_objectId: { providerId: settings.providerId, objectId: profile.id } }, include: { user: true } });
    // A file access binding is not permission to change login authority or to
    // inherit the linked principal's roles. Only the identity settings can do so.
    const binding = await tx.sambaIdentity.findUnique({ where: { adObjectId: profile.id } });
    if (link && ((existing && existing.userId !== link.userId) || (binding && binding.userId !== link.userId))) throw new DirectoryRejected();
    let user = existing?.user || (link ? await tx.user.findUnique({ where: { id: link.userId } }) : null);
    if (binding && normalizedDomainDN(binding.domain) !== normalizedDomainDN(adDomainDN(settings.domain))) throw new DirectoryRejected();
    if (existing && binding && binding.userId !== existing.userId) throw new DirectoryRejected();
    if (!user && binding) throw new DirectoryLinkRequired();
    if (!user) {
      if (!settings.autoProvision || binding || link) throw new DirectoryRejected();
      const email = profile.email || `ad-${profile.id}@${settings.domain}.invalid`;
      if (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) throw new DirectoryRejected();
      user = await tx.user.create({ data: { email, name: profile.name, emailVerified: false } });
    }
    if (user.status !== 'ACTIVE') throw new DirectoryRejected();
    const owned = await tx.directoryIdentity.findUnique({ where: { userId: user.id } });
    if (owned && (owned.providerId !== settings.providerId || owned.objectId !== profile.id)) throw new DirectoryRejected();
    await tx.directoryIdentity.upsert({ where: { userId: user.id },
      create: { userId: user.id, providerId: settings.providerId, objectId: profile.id, accountName: profile.accountName, groupSids: profile.groupSids, roleNames },
      update: { accountName: profile.accountName, groupSids: profile.groupSids, roleNames, checkedAt: new Date() },
    });
    // Keep the existing local credential, manual roles and User.id intact.
    const account = await tx.account.findUnique({ where: { providerId_accountId: { providerId: settings.providerId, accountId: profile.id } } });
    if (account && account.userId !== user.id) throw new DirectoryRejected();
    if (!account)
      await tx.account.create({ data: { providerId: settings.providerId, accountId: profile.id, userId: user.id } });
    if (getConfig().samba.enabled) {
      const current = await tx.sambaIdentity.findUnique({ where: { userId: user.id } });
      if (current && (current.adObjectId !== profile.id || normalizedDomainDN(current.domain) !== normalizedDomainDN(adDomainDN(settings.domain)))) throw new DirectoryRejected();
      await tx.sambaIdentity.upsert({ where: { userId: user.id }, create: { userId: user.id, adObjectId: profile.id, domain: adDomainDN(settings.domain), accountName: profile.accountName, linkedBy: 'directory-login' }, update: { accountName: profile.accountName } });
    }
    if (link) await tx.sambaOperation.create({ data: { id: randomUUID(), actorId: link.actorId, actorName: link.actorName, action: 'directory.identity.link', requestHash: '-', metadata: { userId: user.id, providerId: settings.providerId, objectId: profile.id }, state: 'succeeded' } });
    // Changing the authentication authority invalidates old local sessions and pending MFA challenges.
    if (!existing) user = await tx.user.update({ where: { id: user.id }, data: { sessionEpoch: { increment: 1 } } });
    return user;
  });
  // A just-verified password must not inherit an older cached pwdLastSet fingerprint.
  await authRedis.set(profileKey(profile.id), JSON.stringify(profile), { EX: 30 });
  return user;
}
export async function refreshDirectoryIdentity(db: PrismaClient, userId: string) {
  if (!directoryClient || !directorySettings) throw new DirectoryRejected();
  const identity = await db.directoryIdentity.findUnique({ where: { userId } });
  if (!identity || identity.providerId !== directorySettings.providerId) throw new DirectoryRejected();
  const raw = await authRedis.get(profileKey(identity.objectId));
  let profile: DirectoryProfile;
  if (raw) profile = JSON.parse(raw);
  else {
    profile = await directoryClient.profile(identity.objectId);
    await authRedis.set(profileKey(identity.objectId), JSON.stringify(profile), { EX: 30 });
  }
  const roleNames = await mappedDirectoryRoles(db, profile.groupSids);
  if (identity.accountName !== profile.accountName || JSON.stringify(identity.groupSids) !== JSON.stringify(profile.groupSids) || JSON.stringify(identity.roleNames) !== JSON.stringify(roleNames))
    await db.directoryIdentity.update({ where: { userId }, data: { accountName: profile.accountName, groupSids: profile.groupSids, roleNames, checkedAt: new Date() } });
  return { profile, roleNames };
}
export async function verifyDirectoryPassword(db: PrismaClient, userId: string, password: string) {
  if (!directoryClient || !directorySettings) throw new DirectoryRejected();
  const identity = await db.directoryIdentity.findUnique({ where: { userId } });
  if (!identity || identity.providerId !== directorySettings.providerId) throw new DirectoryRejected();
  const profile = await directoryClient.profile(identity.objectId);
  return directoryClient.verify(profile, password);
}
export async function validatedDirectorySession(db: PrismaClient, token: string, userId: string) {
  const raw = await authRedis.get(directorySessionKey(token));
  if (!raw) {
    if (directorySettings && await db.directoryIdentity.findUnique({ where: { userId } })) throw new DirectoryRejected();
    return null;
  }
  const marker: DirectorySession = JSON.parse(raw);
  const state = await refreshDirectoryIdentity(db, userId);
  if (marker.userId !== userId || marker.providerId !== directorySettings?.providerId || marker.objectId !== state.profile.id || marker.securityStamp !== state.profile.securityStamp)
    throw new DirectoryRejected();
  return state;
}
export async function directorySessionForUser(db: PrismaClient, userId: string): Promise<DirectorySession | null> {
  if (!directorySettings || !await db.directoryIdentity.findUnique({ where: { userId } })) return null;
  const { profile } = await refreshDirectoryIdentity(db, userId);
  return { userId, providerId: directorySettings.providerId, objectId: profile.id, securityStamp: profile.securityStamp };
}
export async function stampDirectorySession(ctx: any, session: { token: string; userId: string; expiresAt: Date }, db?: PrismaClient) {
  let stamp: DirectorySession | null = ctx?.context?.assayDirectorySession || null;
  const source = ctx?.context?.session?.session?.token;
  if (!stamp && source) {
    const raw = await authRedis.get(directorySessionKey(source));
    if (raw) stamp = JSON.parse(raw);
  }
  // Epoch stamping already authenticated the signed MFA challenge. OIDC's pending
  // challenge carries no AD password; reread its explicitly linked directory principal.
  if (!stamp && !source && db && ctx?.path?.startsWith('/two-factor/verify-')) stamp = await directorySessionForUser(db, session.userId);
  if (stamp) {
    if (stamp.userId !== session.userId) throw new DirectoryRejected();
    const ttl = Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
    if (ttl <= 0) throw new DirectoryRejected();
    await authRedis.set(directorySessionKey(session.token), JSON.stringify(stamp), { EX: ttl });
  }
}
// Registered by Nest at startup. No password crosses a redirect, Redis or database.
type FileConnector = (session: { token: string; userId: string; expiresAt: Date }, password: string, origin: string) => Promise<void>;
let connectFiles: FileConnector | undefined;
export function registerDirectoryFileConnector(connector: FileConnector) { connectFiles = connector; }
export async function connectDirectoryFiles(session: Parameters<FileConnector>[0], password: string, origin: string) {
  const config = getConfig();
  if (!config.samba.enabled || !config.files.enabled) return false;
  if (!connectFiles) return false;
  try { await connectFiles(session, password, origin); return true; }
  catch { return false; } // Business login remains available when optional SMB transport is down.
}
