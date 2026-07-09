import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { StorageDriver, PutObjectInput } from './storage.interface';

/**
 * 本地文件系统实现。附件写入 baseDir，DB 只存 key（相对路径）。
 * presignGet 返回后端代理下载地址（由 attachments 控制器实现，P3）。
 */
export class LocalFsStorage implements StorageDriver {
  readonly name = 'local';

  constructor(private readonly baseDir: string) {}

  private full(key: string): string {
    // 防目录穿越
    const target = resolve(this.baseDir, key);
    if (!target.startsWith(resolve(this.baseDir))) {
      throw new Error('Invalid object key');
    }
    return target;
  }

  async put(input: PutObjectInput): Promise<void> {
    const path = this.full(input.key);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, input.body);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.full(key));
  }

  async presignGet(key: string): Promise<string> {
    // 本地无预签名，返回内部代理路径，由 API 鉴权后回传文件
    return `/attachments/download?key=${encodeURIComponent(key)}`;
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.full(key), { force: true });
  }

  static fromEnv(): LocalFsStorage {
    const dir = process.env.STORAGE_LOCAL_DIR || join(process.cwd(), 'storage-data');
    return new LocalFsStorage(dir);
  }
}
