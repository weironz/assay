import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
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

  // 关闭公开自助注册：拦截 HTTP 注册路由（管理员经服务端 auth.api 建号不受影响）
  expressApp.post(/^\/api\/auth\/sign-up\//, (_req: any, res: any) =>
    res.status(403).json({ error: '已关闭自助注册，请联系管理员创建账号' }),
  );

  // better-auth 路由（登录/登出/会话等）挂在 body parser 之前
  expressApp.all(/^\/api\/auth\//, toNodeHandler(auth));

  // 其余接口恢复 JSON / 表单解析
  app.use(json());
  app.use(urlencoded({ extended: true }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.API_PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`API 已启动: http://localhost:${port}`);
}
bootstrap();
