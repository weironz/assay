/* Only used inside the uniquely named local upgrade sandbox's RustFS network
 * namespace. It never accepts a production endpoint or production credentials. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

async function main() {
  const manifest = JSON.parse(fs.readFileSync('/source/objects-manifest.json', 'utf8'));
  const client = new S3Client({ endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: 'ciaccesskey', secretAccessKey: 'cisecretkey' } });
  try {
    await client.send(new CreateBucketCommand({ Bucket: 'assay-attachments' }));
    for (const object of manifest) {
      if (!object.key || object.key.split('/').some(part => !part || part === '.' || part === '..') || object.key.includes('\\')) {
        throw new Error('Unsafe backup object key');
      }
      const filename = path.join('/source/objects', object.key);
      const content = fs.readFileSync(filename);
      if (crypto.createHash('sha256').update(content).digest('hex') !== object.sha256) throw new Error('Backup object checksum mismatch');
      await client.send(new PutObjectCommand({ Bucket: 'assay-attachments', Key: object.key, Body: content,
        ContentType: object.contentType, CacheControl: object.cacheControl, ContentDisposition: object.contentDisposition,
        ContentEncoding: object.contentEncoding, Metadata: object.metadata }));
      const restored = await client.send(new GetObjectCommand({ Bucket: 'assay-attachments', Key: object.key }));
      const hash = crypto.createHash('sha256');
      for await (const chunk of restored.Body) hash.update(chunk);
      if (hash.digest('hex') !== object.sha256) throw new Error('Restored object checksum mismatch');
    }
    console.log(JSON.stringify({ restoredAndVerifiedObjects: manifest.length }));
  } finally { client.destroy(); }
}
main().catch(error => { console.error('Upgrade sandbox S3 restore failed:', error.name); process.exitCode = 1; });
