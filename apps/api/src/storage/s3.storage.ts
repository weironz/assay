import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageDriver, PutObjectInput } from './storage.interface';

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

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async presignGet(key: string, expiresInSec = 600): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSec },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  static fromEnv(): S3Storage {
    return new S3Storage(
      process.env.S3_BUCKET || 'assay-attachments',
      process.env.S3_ENDPOINT || 'http://rustfs:9000',
      process.env.S3_REGION || 'us-east-1',
      process.env.S3_ACCESS_KEY || 'rustfsadmin',
      process.env.S3_SECRET_KEY || 'rustfsadmin',
      (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
    );
  }
}
