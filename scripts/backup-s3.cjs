/* Export with the S3 SDK already present in the selected API image. No registry
 * download is needed. Credentials are supplied through the child environment. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function validateObjectKey(key) {
  if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') ||
      key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('S3 object key cannot be safely represented in a filesystem backup');
  }
  return key;
}

async function main() {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const bucket = process.argv[2];
  if (!bucket) throw new Error('Backup bucket is required');
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:9000', region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
  });
  try {
    async function list() {
      const objects = [];
      let token;
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const object of result.Contents || []) objects.push({
          key: validateObjectKey(object.Key), size: object.Size || 0,
          etag: object.ETag, lastModified: object.LastModified?.toISOString(),
        });
        token = result.NextContinuationToken;
      } while (token);
      return objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    }
    const before = await list();
    const manifest = [];
    for (const object of before) {
      const filename = path.join('/backup/objects', object.key);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key, IfMatch: object.etag }));
      const hash = crypto.createHash('sha256');
      let size = 0;
      await pipeline(response.Body, new Transform({
        transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); },
      }), fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
      if (size !== object.size || (response.ContentLength !== undefined && size !== response.ContentLength)) {
        throw new Error('S3 object changed during backup');
      }
      manifest.push({ ...object, sha256: hash.digest('hex'),
        contentType: response.ContentType, cacheControl: response.CacheControl,
        contentDisposition: response.ContentDisposition, contentEncoding: response.ContentEncoding,
        metadata: response.Metadata,
      });
    }
    if (JSON.stringify(before) !== JSON.stringify(await list())) throw new Error('S3 object listing changed during backup; retry');
    fs.writeFileSync('/backup/objects-manifest.json', JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ objectCount: manifest.length, totalBytes: manifest.reduce((sum, item) => sum + item.size, 0) }));
  } finally {
    client.destroy();
  }
}

module.exports = { validateObjectKey };
if (require.main === module) main().catch(error => {
  // Neither SDK request details nor credential values belong in backup logs.
  console.error('S3 backup failed:', error.name);
  process.exitCode = 1;
});
