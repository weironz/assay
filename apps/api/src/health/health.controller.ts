import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { constants, promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { createClient } from 'redis';
import { Public } from '../auth/decorators';
import { getConfig } from '../config';
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
      url: getConfig().redis.connectionUrl,
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
      let directory = resolve(getConfig().storage.localDir);
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
    // 与真实存储驱动共用同一份集中配置，避免健康检查“假阳性”。
    const s3 = getConfig().storage.s3;
    if (!s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error('S3 凭据未配置；生产环境必须显式设置 S3_ACCESS_KEY / S3_SECRET_KEY');
    }
    const client = new S3Client({
      endpoint: s3.endpoint,
      region: s3.region,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      forcePathStyle: s3.forcePathStyle,
      maxAttempts: 1,
    });
    try {
      await client.send(
        new HeadBucketCommand({ Bucket: s3.bucket }),
        { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
    } finally {
      client.destroy();
    }
  }
}
