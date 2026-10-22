import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { auth } from './auth/auth';
import { FilesService } from './files/files.service';
import { webSessionFingerprint, webSessionScopes, registerFileSessionRenewal } from './auth/web-session-scope';
import { registerDirectoryFileConnector } from './auth/directory-runtime';
import type { AuthUser } from './auth/auth.types';
import type { Request } from 'express';

async function bootstrap() {
  // 关闭全局 body parser：better-auth 处理器需要读取原始请求体
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // SIGTERM/SIGINT 下触发各模块的 OnModuleDestroy / OnApplicationShutdown：
  // Nest 侧 PrismaService.$disconnect，AuthLifecycleService 收尾 better-auth
  // 的游离 PrismaClient 与 Redis 连接。滚动发布时不至于把连接留在服务端。
  app.enableShutdownHooks();

  app.enableCors({
    origin: (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(','),
    credentials: true,
  });

  const expressApp = app.getHttpAdapter().getInstance();
  registerDirectoryFileConnector(async (session, password, origin) => {
    const req = { headers: { origin } } as Request;
    webSessionScopes.set(req, { fingerprint: webSessionFingerprint(session.token), expiresAt: new Date(session.expiresAt).getTime() });
    await app.get(FilesService).login(req, { id: session.userId, authType: 'session' } as AuthUser, { password });
  });
  registerFileSessionRenewal(async ({ userId, ...scope }) => {
    const req = { headers: {} } as Request;
    webSessionScopes.set(req, scope);
    await app.get(FilesService).maintain(req, { id: userId, authType: 'session' } as AuthUser);
  });

  // better-auth 路由（登录/注册/登出/会话/邮箱验证/密码重置等）挂在 body parser 之前
  const authHandler = toNodeHandler(auth);
  expressApp.all(/^\/api\/auth\//, async (req: any, res: any) => {
    if (process.env.FILES_ENABLED === 'true' && req.method === 'POST' && req.path === '/api/auth/sign-out') {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session?.session?.token) {
        const owner = webSessionFingerprint(session.session.token);
        res.once('finish', () => {
          if (res.statusCode >= 200 && res.statusCode < 300)
            void app.get(FilesService).revoke(owner, true).catch(() => new Logger('Files').warn('文件会话回收延迟，将由服务端到期清理'));
        });
      }
    }
    return authHandler(req, res);
  });

  // 其余接口恢复 JSON / 表单解析
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true }));

  // 所有 Nest 接口加 /api 前缀（与 better-auth 的 /api/auth 同域，且与前端 SPA 路由隔离）
  // health 排除在外，供容器健康检查直连 /health
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.API_PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  // 排空窗口：app.close() 只等 HTTP server 的自然断开，keep-alive 空闲连接会
  // 拖住停机。收到停机信号后先给在途请求这段时间，超时强制断开全部连接。
  const server = app.getHttpServer() as import('node:http').Server;
  const drainMs = Number(process.env.SHUTDOWN_DRAIN_MS) || 10_000;
  const forceCloseAfterDrain = () => setTimeout(() => server.closeAllConnections?.(), drainMs).unref();
  process.on('SIGTERM', forceCloseAfterDrain);
  process.on('SIGINT', forceCloseAfterDrain);
  new Logger('Bootstrap').log(`API 已启动: http://localhost:${port}`);
}
bootstrap();
