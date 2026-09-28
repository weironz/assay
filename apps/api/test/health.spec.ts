import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Module, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HealthController } from '../src/health/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { STORAGE_DRIVER, StorageDriver } from '../src/storage/storage.interface';

const storage = { name: 's3' } as StorageDriver;
const prisma = { $queryRaw: async () => [1] } as unknown as PrismaService;

@Module({
  controllers: [HealthController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: STORAGE_DRIVER, useValue: storage },
  ],
})
class HealthTestModule {}

test('readiness uses HTTP 503 for every failed dependency; liveness stays independent', async () => {
  const app = await NestFactory.create(HealthTestModule, { logger: false });
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  await app.listen(0, '127.0.0.1');
  try {
    const port = (app.getHttpServer().address() as { port: number }).port;
    const controller = app.get(HealthController) as unknown as Record<string, () => Promise<void>>;
    const endpoint = `http://127.0.0.1:${port}`;
    const healthy = async () => {};
    controller.checkDatabase = healthy;
    controller.checkRedis = healthy;
    controller.checkStorage = healthy;

    const ready = await fetch(`${endpoint}/health`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json() as Record<string, string>;
    assert.deepEqual(
      [readyBody.status, readyBody.db, readyBody.redis, readyBody.storage, readyBody.storageStatus],
      ['ok', 'up', 'up', 's3', 'up'],
    );
    assert.ok(!Number.isNaN(Date.parse(readyBody.time)));

    for (const [failedProbe, field] of [
      ['checkDatabase', 'db'],
      ['checkRedis', 'redis'],
      ['checkStorage', 'storageStatus'],
    ] as const) {
      controller[failedProbe] = async () => { throw new Error('unavailable'); };
      const response = await fetch(`${endpoint}/health`);
      assert.equal(response.status, 503, failedProbe);
      const body = await response.json() as Record<string, string>;
      assert.equal(body.status, 'degraded');
      assert.equal(body[field], 'down');
      assert.equal(body.storage, 's3');
      controller[failedProbe] = healthy;
    }

    controller.checkDatabase = async () => { throw new Error('unavailable'); };
    const live = await fetch(`${endpoint}/api/health/live`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
});

test('S3 probe sends only HEAD to the configured bucket and rejects failures', async () => {
  let method = '';
  let path = '';
  let responseStatus = 200;
  const server = createHttpServer((request, response) => {
    method = request.method || '';
    path = request.url || '';
    response.writeHead(responseStatus).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousEndpoint = process.env.S3_ENDPOINT;
  const previousBucket = process.env.S3_BUCKET;
  try {
    const port = (server.address() as { port: number }).port;
    process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.S3_BUCKET = 'health-test-bucket';
    const controller = new HealthController(prisma, storage) as unknown as Record<string, () => Promise<void>>;
    await controller.checkStorage();
    assert.equal(method, 'HEAD');
    assert.equal(path, '/health-test-bucket/');
    responseStatus = 503;
    await assert.rejects(controller.checkStorage());
  } finally {
    if (previousEndpoint === undefined) delete process.env.S3_ENDPOINT;
    else process.env.S3_ENDPOINT = previousEndpoint;
    if (previousBucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = previousBucket;
    server.close();
  }
});

test('Redis probe uses PING and rejects an unavailable Redis endpoint', async () => {
  const server = createTcpServer((socket) => {
    socket.on('data', (data) => {
      const command = data.toString();
      const count = (command.match(/\*\d+\r\n/g) || []).length;
      socket.write(command.includes('PING') ? '+PONG\r\n' : '+OK\r\n'.repeat(count));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const previousUrl = process.env.REDIS_URL;
  try {
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    const controller = new HealthController(prisma, storage) as unknown as Record<string, () => Promise<void>>;
    await controller.checkRedis();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await assert.rejects(controller.checkRedis());
  } finally {
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
    if (server.listening) server.close();
  }
});

test('local storage probe accepts a creatable directory and rejects a blocked path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assay-health-'));
  const previousDirectory = process.env.STORAGE_LOCAL_DIR;
  const controller = new HealthController(prisma, { name: 'local' } as StorageDriver) as unknown as Record<string, () => Promise<void>>;
  try {
    process.env.STORAGE_LOCAL_DIR = join(directory, 'new', 'attachments');
    await controller.checkStorage();
    const file = join(directory, 'file');
    await writeFile(file, 'occupied');
    process.env.STORAGE_LOCAL_DIR = join(file, 'attachments');
    await assert.rejects(controller.checkStorage());
  } finally {
    if (previousDirectory === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
