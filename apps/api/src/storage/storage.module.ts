import { Global, Module, Logger } from '@nestjs/common';
import { STORAGE_DRIVER, StorageDriver } from './storage.interface';
import { LocalFsStorage } from './local-fs.storage';
import { S3Storage } from './s3.storage';

const BUCKET_INIT_ATTEMPTS = 6;
const BUCKET_INIT_RETRY_DELAY_MS = 2_000;

/**
 * Give RustFS time to become ready after its container starts. If the bucket
 * still cannot be confirmed or created, fail startup so the container can
 * restart and try again instead of serving an indefinitely degraded API.
 */
export async function ensureBucketWithRetry(
  storage: Pick<S3Storage, 'ensureBucket'>,
  attempts = BUCKET_INIT_ATTEMPTS,
  retryDelayMs = BUCKET_INIT_RETRY_DELAY_MS,
): Promise<void> {
  const logger = new Logger('Storage');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await storage.ensureBucket();
      return;
    } catch (error) {
      if (attempt === attempts) {
        logger.error(`S3 bucket 初始化失败（已尝试 ${attempts} 次）: ${(error as Error).message}`);
        throw error;
      }
      logger.warn(
        `S3 bucket 初始化失败（${attempt}/${attempts}），${retryDelayMs}ms 后重试: ${(error as Error).message}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

/**
 * 根据 STORAGE_DRIVER 环境变量选择实现（local | s3）。
 * s3 启动时确保 bucket 存在。
 */
const storageProvider = {
  provide: STORAGE_DRIVER,
  useFactory: async (): Promise<StorageDriver> => {
    const logger = new Logger('Storage');
    const driver = (process.env.STORAGE_DRIVER || 's3').toLowerCase();
    if (driver === 'local') {
      logger.log('使用本地文件系统存储 (LocalFsStorage)');
      return LocalFsStorage.fromEnv();
    }
    const s3 = S3Storage.fromEnv();
    await ensureBucketWithRetry(s3);
    logger.log(`使用 S3 存储 (endpoint=${process.env.S3_ENDPOINT})`);
    return s3;
  },
};

@Global()
@Module({
  providers: [storageProvider],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
