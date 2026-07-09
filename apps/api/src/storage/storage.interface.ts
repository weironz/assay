/**
 * 存储抽象接口。
 * 所有附件读写统一走此接口，实现类可选本地文件系统或 S3（RustFS）。
 * 见 docs/03-技术调研结论.md（RustFS 未 GA，保留可切换能力）。
 */
export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}

export interface StorageDriver {
  /** 上传对象 */
  put(input: PutObjectInput): Promise<void>;
  /** 读取对象为 Buffer */
  get(key: string): Promise<Buffer>;
  /** 生成临时下载 URL（本地实现可返回后端代理地址） */
  presignGet(key: string, expiresInSec?: number): Promise<string>;
  /** 删除对象 */
  delete(key: string): Promise<void>;
  /** 驱动名，便于日志/健康检查 */
  readonly name: string;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
