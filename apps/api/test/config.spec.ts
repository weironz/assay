import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfig } from '../src/config';
import { assertProductionConfig, parseConfig } from '../src/config/schema';

test('defaults stay compatible with the previous per-module fallbacks', () => {
  const config = parseConfig({});
  assert.equal(config.api.port, 3000);
  assert.equal(config.api.shutdownDrainMs, 10_000);
  assert.deepEqual(config.auth.trustedOrigins, ['http://localhost:5173']);
  assert.equal(config.auth.baseUrl, 'http://localhost:3000');
  assert.equal(config.redis.connectionUrl, 'redis://redis:6379');
  assert.equal(config.redis.host, 'redis');
  assert.equal(config.redis.port, 6379);
  assert.equal(config.storage.driver, 's3');
  assert.equal(config.storage.s3.bucket, 'assay-attachments');
  assert.equal(config.storage.s3.endpoint, 'http://rustfs:9000');
  assert.equal(config.storage.s3.forcePathStyle, true);
  assert.equal(config.mail.provider, 'none');
  assert.equal(config.auth.requireEmailVerification, false);
  assert.equal(config.attachments.draftCleanupEnabled, false);
});

test('historical draft cleanup requires explicit opt-in', () => {
  assert.equal(parseConfig({ ATTACHMENT_DRAFT_CLEANUP_ENABLED: 'true' }).attachments.draftCleanupEnabled, true);
  for (const value of ['', 'false', '1', 'True']) {
    assert.equal(parseConfig({ ATTACHMENT_DRAFT_CLEANUP_ENABLED: value }).attachments.draftCleanupEnabled, false);
  }
});

test('non-production keeps the local rustfsadmin fallback for development', () => {
  const config = parseConfig({ NODE_ENV: 'development' });
  assert.equal(config.storage.s3.accessKeyId, 'rustfsadmin');
  assert.equal(config.storage.s3.secretAccessKey, 'rustfsadmin');
  assert.doesNotThrow(() => assertProductionConfig(config));
});

test('production removes the public S3 credential fallback and refuses startup', () => {
  const config = parseConfig({
    NODE_ENV: 'production',
    AUTH_TRUST_ORIGINS: 'https://assay.example.test',
  });
  assert.equal(config.storage.s3.accessKeyId, undefined);
  assert.equal(config.storage.s3.secretAccessKey, undefined);
  assert.throws(() => assertProductionConfig(config), /S3_ACCESS_KEY/);
});

test('production accepts explicitly configured S3 credentials', () => {
  const config = parseConfig({
    NODE_ENV: 'production',
    AUTH_TRUST_ORIGINS: 'https://assay.example.test',
    S3_ACCESS_KEY: 'production-access-key',
    S3_SECRET_KEY: 'production-secret-key',
  });
  assert.equal(config.storage.s3.accessKeyId, 'production-access-key');
  assert.doesNotThrow(() => assertProductionConfig(config));
});

test('production requires explicit trusted origins', () => {
  const config = parseConfig({
    NODE_ENV: 'production',
    S3_ACCESS_KEY: 'production-access-key',
    S3_SECRET_KEY: 'production-secret-key',
  });
  assert.equal(config.auth.trustedOriginsConfigured, false);
  assert.throws(() => assertProductionConfig(config), /AUTH_TRUST_ORIGINS/);
});

test('production local storage does not require S3 credentials', () => {
  const config = parseConfig({
    NODE_ENV: 'production',
    AUTH_TRUST_ORIGINS: 'https://assay.example.test',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: '/data/attachments',
  });
  assert.equal(config.storage.driver, 'local');
  assert.doesNotThrow(() => assertProductionConfig(config));
});

test('invalid trusted origins fail schema validation at startup', () => {
  assert.throws(
    () => parseConfig({ AUTH_TRUST_ORIGINS: 'https://assay.example.test/path' }),
    /AUTH_TRUST_ORIGINS/,
  );
  assert.throws(
    () => parseConfig({ AUTH_TRUST_ORIGINS: 'http://user:pass@assay.example.test' }),
    /AUTH_TRUST_ORIGINS/,
  );
});

test('trusted origins are trimmed and normalized to exact origins', () => {
  const config = parseConfig({
    AUTH_TRUST_ORIGINS: ' https://assay.example.test/ , http://localhost:5173 ',
  });
  assert.deepEqual(config.auth.trustedOrigins, [
    'https://assay.example.test',
    'http://localhost:5173',
  ]);
});

test('empty optional flags behave like unset (.env / Compose compatibility)', () => {
  const config = parseConfig({
    REQUIRE_EMAIL_VERIFICATION: '',
    SMTP_HOST: 'smtp.example.test',
  });
  assert.equal(config.mail.provider, 'smtp');
  assert.equal(config.auth.requireEmailVerification, true);
});

test('getConfig re-reads after process.env changes (test/hot-reload compatibility)', () => {
  const previousSamba = process.env.SAMBA_ENABLED;
  const previousFiles = process.env.FILES_ENABLED;
  try {
    process.env.SAMBA_ENABLED = 'true';
    process.env.FILES_ENABLED = 'true';
    assert.deepEqual(getConfig().files.enabled, true);

    process.env.FILES_ENABLED = 'false';
    assert.deepEqual(getConfig().files.enabled, false);
    assert.equal(getConfig().samba.enabled, true);
  } finally {
    if (previousSamba === undefined) delete process.env.SAMBA_ENABLED;
    else process.env.SAMBA_ENABLED = previousSamba;
    if (previousFiles === undefined) delete process.env.FILES_ENABLED;
    else process.env.FILES_ENABLED = previousFiles;
  }
});
