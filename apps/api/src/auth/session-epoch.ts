import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APIError } from 'better-auth';
import type { PrismaClient } from '@prisma/client';
import { authRedis } from './auth-redis';

type EpochDb = Pick<PrismaClient, 'user' | '$queryRawUnsafe'> & Partial<Pick<PrismaClient, '$transaction'>>;
type EpochSnapshot = { userId: string; epoch: number };
type EpochContext = {
  path?: string;
  body?: unknown;
  getSignedCookie?: (name: string, secret: string) => Promise<string | false | null | undefined>;
  context?: {
    secret?: string;
    createAuthCookie?: (name: string) => { name: string };
    session?: { user: { id: string }; session: { token: string } } | null;
    assaySignInEpoch?: EpochSnapshot;
  };
};

const markerKey = (token: string) => `assay:session-epoch:${createHash('sha256').update(token).digest('hex')}`;
const challengeKey = (identifier: string) => `assay:2fa-epoch:${createHash('sha256').update(identifier).digest('hex')}`;
const denied = () => new APIError('UNAUTHORIZED', { code: 'SESSION_REVOKED', message: 'Session is no longer valid' });

async function hasSecurityTriggers(db: Pick<PrismaClient, '$queryRawUnsafe'>): Promise<boolean> {
  const result = await db.$queryRawUnsafe<{ ready: boolean }[]>(`
    SELECT COUNT(*) = 5 AS ready
    FROM (VALUES
      ('users'::regclass, 'assay_last_admin_user_delete'),
      ('users'::regclass, 'assay_last_admin_user_status'),
      ('user_roles'::regclass, 'assay_last_admin_role_delete'),
      ('user_roles'::regclass, 'assay_last_admin_role_update'),
      ('accounts'::regclass, 'assay_credential_session_epoch')
    ) AS expected(relation, name)
    JOIN pg_trigger t ON t.tgrelid = expected.relation AND t.tgname = expected.name
    WHERE t.tgenabled IN ('O', 'A')
  `);
  return result[0]?.ready === true;
}

async function bootstrapDevelopmentTriggers(db: EpochDb): Promise<void> {
  if (!db.$transaction) throw new Error('SESSION_EPOCH_MIGRATION_REQUIRED');
  await db.$transaction(async (tx) => {
    // Serialize parallel dev API boots without touching migration history.
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(20260928, 130000) IS NULL AS locked');
    const column = await tx.$queryRawUnsafe<{ valid: boolean }[]>(`
      SELECT a.atttypid = 'pg_catalog.int4'::regtype
         AND a.attnotnull
         AND pg_get_expr(d.adbin, d.adrelid) = '0' AS valid
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'users'::regclass AND a.attname = 'session_epoch'
    `);
    if (column[0]?.valid !== true) throw new Error('SESSION_EPOCH_COLUMN_REQUIRED_RUN_DB_PUSH');
    if (await hasSecurityTriggers(tx)) return;
    // Reuse the checked-in migration bodies, so development and production
    // execute identical trigger logic without touching _prisma_migrations.
    for (const migration of ['20260928120000_last_active_admin', '20260928130000_session_epoch']) {
      const sql = readFileSync(join(__dirname, '../../prisma/migrations', migration, 'migration.sql'), 'utf8');
      const functionStart = sql.indexOf('CREATE FUNCTION');
      const replaceStart = sql.indexOf('CREATE OR REPLACE FUNCTION');
      const start = replaceStart >= 0 ? replaceStart : functionStart;
      const firstTrigger = sql.indexOf('CREATE TRIGGER');
      if (start < 0 || firstTrigger < 0) throw new Error(`INVALID_SECURITY_MIGRATION_${migration}`);
      const functionSql = sql.slice(start, firstTrigger).trim().replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
      await tx.$executeRawUnsafe(functionSql);
      const statements = sql.slice(firstTrigger).match(/CREATE TRIGGER[\s\S]*?;/g) ?? [];
      for (const statement of statements) {
        const name = statement.match(/^CREATE TRIGGER\s+(\w+)/)?.[1];
        if (!name) throw new Error(`INVALID_SECURITY_TRIGGER_${migration}`);
        const existing = await tx.$queryRawUnsafe<{ tgenabled: string }[]>(
          'SELECT tgenabled FROM pg_trigger WHERE tgname = $1', name,
        );
        if (existing.length) {
          if (!['O', 'A'].includes(existing[0].tgenabled)) throw new Error(`DISABLED_SECURITY_TRIGGER_${name}`);
        } else {
          await tx.$executeRawUnsafe(statement);
        }
      }
    }
  });
}

export async function assertSessionEpochMigration(db: EpochDb): Promise<void> {
  if (!await hasSecurityTriggers(db)) {
    if (process.env.NODE_ENV !== 'development') throw new Error('SESSION_EPOCH_MIGRATION_REQUIRED');
    await bootstrapDevelopmentTriggers(db);
    if (!await hasSecurityTriggers(db)) throw new Error('SESSION_EPOCH_MIGRATION_REQUIRED');
  }
}

async function activeEpoch(db: EpochDb, userId: string): Promise<number> {
  await assertSessionEpochMigration(db);
  const user = await db.user.findUnique({ where: { id: userId }, select: { sessionEpoch: true, status: true } });
  if (!user || user.status !== 'ACTIVE') throw denied();
  return user.sessionEpoch;
}

async function markerMatches(db: EpochDb, token: string, userId: string): Promise<boolean> {
  const marker = await authRedis.get(markerKey(token));
  // Read the durable epoch last: a reset committing between the two reads
  // must reject the old marker, not authenticate from an earlier DB snapshot.
  const epoch = await activeEpoch(db, userId);
  // Pre-rollout sessions have no marker and implicitly belong to epoch 0.
  // After the first revocation, missing markers always fail closed.
  return marker === null ? epoch === 0 : marker === String(epoch);
}

export async function captureAuthEpoch(db: EpochDb, ctx: EpochContext): Promise<void> {
  if (ctx.path === '/sign-up/email' || ctx.path === '/reset-password' || ctx.path === '/change-password' || ctx.path === '/set-password') {
    await assertSessionEpochMigration(db);
  }
  if (ctx.path === '/sign-in/email') {
    await assertSessionEpochMigration(db);
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string') return;
    const user = await db.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, sessionEpoch: true, status: true } });
    if (user && user.status === 'ACTIVE' && ctx.context) {
      ctx.context.assaySignInEpoch = { userId: user.id, epoch: user.sessionEpoch };
    }
  }
}

export async function stampTwoFactorChallenge(ctx: EpochContext | null, data: { identifier: string; value: string; expiresAt: Date }): Promise<void> {
  if (!/^2fa-(?!attempts-)/.test(data.identifier)) return;
  const snapshot = ctx?.context?.assaySignInEpoch;
  if (!snapshot || snapshot.userId !== data.value) throw denied();
  const ttl = Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 1000);
  if (ttl <= 0) throw denied();
  await authRedis.set(challengeKey(data.identifier), JSON.stringify(snapshot), { EX: ttl });
}

export async function stampSessionEpoch(db: EpochDb, ctx: EpochContext | null, session: { token: string; userId: string; expiresAt: Date }): Promise<void> {
  if (!ctx?.context) throw denied();
  const current = await activeEpoch(db, session.userId);
  let snapshot: number;
  if (ctx.path === '/sign-in/email') {
    const signIn = ctx.context.assaySignInEpoch;
    if (!signIn || signIn.userId !== session.userId) throw denied();
    snapshot = signIn.epoch;
  } else if (ctx.path?.startsWith('/two-factor/verify-') && !ctx.context.session) {
    const cookie = ctx.context.createAuthCookie?.('two_factor');
    const identifier = cookie && ctx.context.secret && await ctx.getSignedCookie?.(cookie.name, ctx.context.secret);
    if (!identifier) throw denied();
    const raw = await authRedis.get(challengeKey(identifier));
    if (!raw) throw denied();
    let challenge: EpochSnapshot;
    try { challenge = JSON.parse(raw) as EpochSnapshot; } catch { throw denied(); }
    if (challenge.userId !== session.userId) throw denied();
    snapshot = challenge.epoch;
  } else if (ctx.path === '/sign-up/email') {
    snapshot = current;
  } else {
    const source = ctx.context.session;
    if (!source || source.user.id !== session.userId || !await markerMatches(db, source.session.token, session.userId)) throw denied();
    snapshot = current;
  }
  if (snapshot !== current) throw denied();
  const ttl = Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 1000);
  if (ttl <= 0) throw denied();
  await authRedis.set(markerKey(session.token), String(snapshot), { EX: ttl });
}

export async function readValidatedSession(db: EpochDb, key: string): Promise<string | null> {
  const value = await authRedis.get(key);
  if (!value) return null;
  let parsed: { session?: { token?: string; userId?: string }; user?: { id?: string } };
  try { parsed = JSON.parse(value); } catch { return value; }
  if (!parsed || !parsed.session) return value;
  const userId = parsed.session.userId;
  if (!userId || parsed.session.token !== key || (parsed.user && parsed.user.id !== userId)) return null;
  return await markerMatches(db, key, userId) ? value : null;
}

export async function refreshSessionMarker(key: string, value: string, ttl?: number): Promise<void> {
  if (!ttl) return;
  let parsed: { session?: { token?: string } };
  try { parsed = JSON.parse(value); } catch { return; }
  if (parsed?.session?.token === key) await authRedis.expire(markerKey(key), ttl);
}

export async function assertSessionEpoch(db: EpochDb, token: string, userId: string): Promise<void> {
  if (!await markerMatches(db, token, userId)) throw denied();
}
