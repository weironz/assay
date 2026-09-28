import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { S3Storage } from '../src/storage/s3.storage';
import { STORAGE_DRIVER } from '../src/storage/storage.interface';
import { ensureBucketWithRetry, StorageModule } from '../src/storage/storage.module';

test('bucket initialization recovers when storage becomes available within the retry budget', async () => {
  let attempts = 0;
  await ensureBucketWithRetry({
    ensureBucket: async () => {
      attempts++;
      if (attempts < 3) throw new Error('RustFS is starting');
    },
  }, 3, 0);
  assert.equal(attempts, 3);
});

test('bucket initialization fails startup after the retry budget is exhausted', async () => {
  const failure = new Error('RustFS unavailable');
  let attempts = 0;
  await assert.rejects(
    ensureBucketWithRetry({
      ensureBucket: async () => {
        attempts++;
        throw failure;
      },
    }, 3, 0),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 3);
});

test('StorageModule waits for bucket initialization before providing S3 storage', async () => {
  const originalFromEnv = S3Storage.fromEnv;
  let attempts = 0;
  const storage = {
    name: 's3',
    ensureBucket: async () => {
      attempts++;
      if (attempts === 1) throw new Error('RustFS is starting');
    },
  } as S3Storage;
  S3Storage.fromEnv = () => storage;
  const previousDriver = process.env.STORAGE_DRIVER;
  process.env.STORAGE_DRIVER = 's3';
  try {
    const app = await NestFactory.createApplicationContext(StorageModule, { logger: false });
    try {
      assert.equal(attempts, 2);
      assert.equal(app.get(STORAGE_DRIVER), storage);
    } finally {
      await app.close();
    }
  } finally {
    S3Storage.fromEnv = originalFromEnv;
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
  }
});
