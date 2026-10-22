import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireAuthSecret } from '../src/auth/auth-secret';

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const keys = ['AUTH_SECRET', 'NODE_ENV'];
  const previous = keys.map((key) => process.env[key]);
  const merged = { NODE_ENV: 'production', ...env };
  for (const key of keys) {
    if (merged[key as keyof typeof merged] === undefined) delete process.env[key];
    else process.env[key] = merged[key as keyof typeof merged];
  }
  try {
    run();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

const STRONG = 'k9W3mX7pQ2rT8vZ5nB1cF4gH6jL0sD9aE3yU7iO2';

test('production accepts a strong random secret of sufficient length', () => {
  withEnv({ AUTH_SECRET: STRONG }, () => {
    assert.equal(requireAuthSecret(), STRONG);
  });
});

test('production rejects missing or short secrets', () => {
  withEnv({ AUTH_SECRET: undefined }, () => {
    assert.throws(requireAuthSecret, /AUTH_SECRET 缺失或长度不足/);
  });
  withEnv({ AUTH_SECRET: 'only-31-chars-xxxxxxxxx123456' }, () => {
    assert.throws(requireAuthSecret, /AUTH_SECRET 缺失或长度不足/);
  });
});

test('production rejects every known placeholder from repo templates', () => {
  for (const placeholder of [
    'change_me_in_prod_please_use_long_random_string',
    'CHANGE_ME_long_random_secret_with_padding_1',
    'dev_secret_change_me',
  ]) {
    withEnv({ AUTH_SECRET: placeholder }, () => {
      assert.throws(requireAuthSecret, /openssl rand -base64 48/, placeholder);
    });
  }
});

test('production rejects low-entropy repeated-character secrets', () => {
  withEnv({ AUTH_SECRET: 'a'.repeat(64) }, () => {
    assert.throws(requireAuthSecret, /低熵/);
  });
});

test('non-production keeps permissive behavior for local development', () => {
  withEnv({ NODE_ENV: 'development', AUTH_SECRET: undefined }, () => {
    assert.equal(requireAuthSecret(), 'dev_secret_change_me');
  });
  withEnv({ NODE_ENV: 'development', AUTH_SECRET: 'change_me_in_prod_please_use_long_random_string' }, () => {
    assert.equal(requireAuthSecret(), 'change_me_in_prod_please_use_long_random_string');
  });
});
