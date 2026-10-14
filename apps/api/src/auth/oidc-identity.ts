import type { PrismaClient } from '@prisma/client';
import type { OidcSettings } from './oidc-config';
import type { OidcProfile } from './oidc-client';

export type OidcLink = { userId: string; epoch: number; sessionHash: string };

export async function resolveOidcIdentity(db: PrismaClient, settings: OidcSettings, profile: OidcProfile, link?: OidcLink) {
  return db.$transaction(async tx => {
    // Serialize identity provisioning/linking on every API instance, including first login races.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(73020261014::bigint) IS NULL AS locked`;
    const account = await tx.account.findUnique({
      where: { providerId_accountId: { providerId: settings.providerId, accountId: profile.subject } },
      include: { user: true },
    });
    if (account) {
      if (link && account.userId !== link.userId) throw new Error('OIDC_IDENTITY_ALREADY_LINKED');
      if (account.user.status !== 'ACTIVE' || (link && account.user.sessionEpoch !== link.epoch)) throw new Error('OIDC_ACCOUNT_DISABLED');
      return account.user;
    }
    let user = link ? await tx.user.findUnique({ where: { id: link.userId } }) : null;
    if (link) {
      if (!user || user.status !== 'ACTIVE' || user.sessionEpoch !== link.epoch ||
          !user.emailVerified || user.email.toLowerCase() !== profile.email) throw new Error('OIDC_LINK_DENIED');
      if (await tx.account.findFirst({ where: { userId: user.id, providerId: settings.providerId } })) throw new Error('OIDC_OTHER_IDENTITY_LINKED');
    } else {
      // An IdP email is not permission to take over a local account, even if verified.
      if (await tx.user.findFirst({ where: { email: { equals: profile.email, mode: 'insensitive' } } })) throw new Error('OIDC_ACCOUNT_NOT_LINKED');
      if (!settings.autoProvision) throw new Error('OIDC_PROVISIONING_DISABLED');
      const role = await tx.role.findUnique({ where: { name: 'requester' } });
      if (!role) throw new Error('OIDC_DEFAULT_ROLE_MISSING');
      user = await tx.user.create({ data: {
        name: profile.name, email: profile.email, emailVerified: true,
        roles: { create: { roleId: role.id } },
      } });
    }
    await tx.account.create({ data: { providerId: settings.providerId, accountId: profile.subject, userId: user!.id } });
    return user!;
  });
}
