/**
 * 在任何业务模块求值前把 .env 载入 process.env。
 *
 * auth.ts / auth-redis.ts / mailer.ts / attachments/limits.ts 等在模块顶层
 * 调用/缓存 getConfig() 并冻结快照（AUTH_SECRET、trusted origins、Redis URL、
 * 上传限额）。CommonJS 下 import 顺序即 require 求值顺序——若 .env 等到
 * AppModule 里 ConfigModule.forRoot() 才加载，只依赖 .env 的部署会先用
 * 默认值冻结这些快照。因此入口文件必须把本模块作为第一条 import。
 *
 * 注意：dotenv 默认不覆盖已存在的进程环境变量，与 ConfigModule 行为一致。
 */
import 'dotenv/config';
