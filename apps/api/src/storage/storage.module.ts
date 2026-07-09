import { Global, Module, Logger } from '@nestjs/common';
import { STORAGE_DRIVER, StorageDriver } from './storage.interface';
import { LocalFsStorage } from './local-fs.storage';
import { S3Storage } from './s3.storage';

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
    try {
      await s3.ensureBucket();
      logger.log(`使用 S3 存储 (endpoint=${process.env.S3_ENDPOINT})`);
    } catch (e) {
      logger.warn(
        `S3 bucket 初始化失败（RustFS 可能未就绪），稍后重试: ${(e as Error).message}`,
      );
    }
    return s3;
  },
};

@Global()
@Module({
  providers: [storageProvider],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
