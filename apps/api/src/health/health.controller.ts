import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { constants, promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { createClient } from 'redis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../storage/storage.interface';

const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Health probe timed out')), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  @Public()
  @Get('health')
  async health() {
    const [database, redis, storage] = await Promise.allSettled([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkStorage(),
    ]);
    const db = database.status === 'fulfilled' ? 'up' : 'down';
    const redisStatus = redis.status === 'fulfilled' ? 'up' : 'down';
    const storageStatus = storage.status === 'fulfilled' ? 'up' : 'down';
    const status = db === 'up' && redisStatus === 'up' && storageStatus === 'up'
      ? 'ok'
      : 'degraded';
    const result = {
      status,
      db,
      redis: redisStatus,
      storage: this.storage.name,
      storageStatus,
      time: new Date().toISOString(),
    };
    if (status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }

  // /health remains the deployment readiness URL. Only that path is excluded
  // from the global /api prefix, so liveness is at /api/health/live.
  @Public()
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  protected async checkDatabase(): Promise<void> {
    await withTimeout(this.prisma.$queryRaw`SELECT 1`);
  }

  protected async checkRedis(): Promise<void> {
    // Match better-auth's Redis URL. A short-lived client has no background
    // reconnect or shutdown lifecycle to manage.
    const client = createClient({
      url: process.env.REDIS_URL || 'redis://redis:6379',
      disableOfflineQueue: true,
      socket: {
        connectTimeout: PROBE_TIMEOUT_MS,
        reconnectStrategy: false,
      },
    });
    client.on('error', () => {});
    try {
      await withTimeout(client.connect());
      if (await withTimeout(client.ping()) !== 'PONG') {
        throw new Error('Redis PING failed');
      }
    } finally {
      if (client.isOpen) await client.disconnect();
    }
  }

  protected async checkStorage(): Promise<void> {
    if (this.storage.name === 'local') {
      let directory = resolve(process.env.STORAGE_LOCAL_DIR || join(process.cwd(), 'storage-data'));
      // LocalFsStorage creates its directory on first upload. Until then the
      // nearest existing parent must be writable so that creation can work.
      for (;;) {
        try {
          const stats = await withTimeout(fs.stat(directory));
          if (!stats.isDirectory()) throw new Error('Storage path is not a directory');
          await withTimeout(fs.access(directory, constants.R_OK | constants.W_OK));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const parent = dirname(directory);
          if (parent === directory) throw error;
          directory = parent;
        }
      }
      return;
    }
    if (this.storage.name !== 's3') throw new Error('Unknown storage driver');

    // HEAD checks the configured bucket and credentials without changing data.
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || 'http://rustfs:9000',
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || 'rustfsadmin',
        secretAccessKey: process.env.S3_SECRET_KEY || 'rustfsadmin',
      },
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
      maxAttempts: 1,
    });
    try {
      await client.send(
        new HeadBucketCommand({ Bucket: process.env.S3_BUCKET || 'assay-attachments' }),
        { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
    } finally {
      client.destroy();
    }
  }
}
