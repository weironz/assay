import type { PrismaClient } from '@prisma/client';

/** Directory-derived staff lists must not keep authorizing disabled or departed members. */
export async function directoryRoleUserIds(db: PrismaClient, roles: string[]): Promise<string[]> {
  if (process.env.DIRECTORY_AUTH_ENABLED !== 'true') return [];
  const { directorySettings, refreshDirectoryIdentity } = await import('./directory-runtime');
  if (!directorySettings) return [];
  const candidates = await db.directoryIdentity.findMany({ where: {
    providerId: directorySettings.providerId, user: { status: 'ACTIVE' },
    OR: [{ roleNames: { hasSome: roles } }, { user: { roles: { some: { role: { name: { in: roles } } } } } }],
  }, select: { userId: true, user: { select: { roles: { where: { role: { name: { in: roles } } }, select: { roleId: true } } } } } });
  const result: string[] = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const checked = await Promise.all(candidates.slice(i, i + 4).map(async ({ userId, user }) => {
      try { const state = await refreshDirectoryIdentity(db, userId); return state.roleNames.some(r => roles.includes(r)) || user?.roles.length ? userId : null; }
      catch { return null; }
    }));
    result.push(...checked.filter((id): id is string => id !== null));
  }
  return result;
}
