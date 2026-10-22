/**
 * 集中配置唯一入口。
 *
 * 业务代码使用 `getConfig()` 读取已经校验过的结构化配置；需要按现有
 * 「传入 env 便于单测」签名的领域解析器（directory / oidc / login-policy）
 * 使用 `currentEnv()` 作为默认值，仍然不直接触碰 process.env。
 *
 * 缓存策略：按参与 schema 的环境变量值计算指纹。这样：
 * - 正常运行时只解析一次；
 * - 单测/热重载在运行中修改 process.env 后，下一次读取会重新校验并生效，
 *   不会拿到旧快照（现有测试大量使用这种写法）。
 */
import type { AppConfig } from './schema';
import {
  CONFIG_ENV_KEYS,
  assertProductionConfig,
  parseConfig,
} from './schema';

export * from './schema';

interface CacheEntry {
  fingerprint: string;
  config: AppConfig;
}

let cache: CacheEntry | undefined;

function fingerprint(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(CONFIG_ENV_KEYS.map((key) => [key, env[key] ?? null]));
}

/** 当前进程环境变量的只读视图（仅供领域解析器的默认参数使用）。 */
export function currentEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** 读取并缓存结构化配置；环境变化时自动重新校验。 */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const next = fingerprint(env);
  if (!cache || cache.fingerprint !== next) {
    cache = { fingerprint: next, config: parseConfig(env) };
  }
  return cache.config;
}

/**
 * 供 `ConfigModule.forRoot({ validate })` 使用：启动期完成 schema 校验 +
 * 生产敏感默认值检查，失败直接拒绝启动。
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  assertProductionConfig(getConfig(env));
  return env;
}
