import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';
import { getConfig } from '../config';
import {
  StorageDriver,
  PutObjectInput,
  PutStreamInput,
} from './storage.interface';

/**
 * S3 兼容实现，指向 RustFS（也可指向 Garage / 云 OSS，仅换 endpoint）。
 */
export class S3Storage implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    endpoint: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
    forcePathStyle: boolean,
  ) {
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle,
    });
  }

  /** 确保 bucket 存在（启动时调用一次） */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  /**
   * 分片上传：内存占用约等于 partSize × queueSize（这里 8MB × 4 = 32MB），
   * 与文件大小无关。单次 PutObject 传大文件会把整包读进内存。
   */
  async putStream(input: PutStreamInput): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
      // 失败时把已上传的分片清掉，否则会在桶里留下收费的垃圾分片
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return res.Body as Readable;
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  static fromEnv(): S3Storage {
    const s3 = getConfig().storage.s3;
    if (!s3.accessKeyId || !s3.secretAccessKey) {
      throw new Error(
        'S3 凭据未配置：生产环境必须显式设置 S3_ACCESS_KEY 与 S3_SECRET_KEY，禁止回退公开的 rustfsadmin',
      );
    }
    return new S3Storage(
      s3.bucket,
      s3.endpoint,
      s3.region,
      s3.accessKeyId,
      s3.secretAccessKey,
      s3.forcePathStyle,
    );
  }
}
