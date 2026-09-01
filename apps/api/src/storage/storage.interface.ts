/**
 * 存储抽象接口。
 * 所有附件读写统一走此接口，实现类可选本地文件系统或 S3（RustFS）。
 * 见 docs/03-技术调研结论.md（RustFS 未 GA，保留可切换能力）。
 */
import type { Readable } from 'stream';

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}

export interface PutStreamInput {
  key: string;
  body: Readable;
  contentType?: string;
}

export interface StorageDriver {
  /** 上传对象（小对象用，整包在内存里） */
  put(input: PutObjectInput): Promise<void>;
  /**
   * 流式上传。大文件必须走这个：整包进内存的话，一个 512MB 的附件就要占
   * 512MB 常驻内存，两个人同传就把容器打爆。
   */
  putStream(input: PutStreamInput): Promise<void>;
  /** 读取对象为 Buffer（小对象用） */
  get(key: string): Promise<Buffer>;
  /** 流式读取，供下载直接转发，避免整包进内存 */
  getStream(key: string): Promise<Readable>;
  /** 生成临时下载 URL（本地实现可返回后端代理地址） */
  presignGet(key: string, expiresInSec?: number): Promise<string>;
  /** 删除对象 */
  delete(key: string): Promise<void>;
  /** 驱动名，便于日志/健康检查 */
  readonly name: string;
}

export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
