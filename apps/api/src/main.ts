import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { AppModule } from './app.module';
import { auth } from './auth/auth';

async function bootstrap() {
  // 关闭全局 body parser：better-auth 处理器需要读取原始请求体
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  app.enableCors({
    origin: (process.env.AUTH_TRUST_ORIGINS || 'http://localhost:5173').split(','),
    credentials: true,
  });

  const expressApp = app.getHttpAdapter().getInstance();

  // better-auth 路由（登录/注册/登出/会话/邮箱验证/密码重置等）挂在 body parser 之前
  expressApp.all(/^\/api\/auth\//, toNodeHandler(auth));

  // 其余接口恢复 JSON / 表单解析
  app.use(json());
  app.use(urlencoded({ extended: true }));

  // 所有 Nest 接口加 /api 前缀（与 better-auth 的 /api/auth 同域，且与前端 SPA 路由隔离）
  // health 排除在外，供容器健康检查直连 /health
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.API_PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API 已启动: http://localhost:${port}`);
}
bootstrap();
