/**
 * AUTH_SECRET 启动期校验，better-auth（auth.ts）与员工文件模块
 * （web-session-scope.ts）共用同一入口，避免同一配置两处行为不一致。
 *
 * 该密钥用于会话 Cookie 签名、OAuth state、2FA 密钥加密等安全边界：
 * - 生产环境缺失或长度不足 32 字符时直接抛错，拒绝启动；
 * - 其他环境允许占位密钥，保证本地起得来，但不再使用硬编码默认值兜底生产。
 */
const MIN_SECRET_LENGTH = 32;
const DEV_FALLBACK_SECRET = 'dev_secret_change_me_not_for_production';

export function requireAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `AUTH_SECRET 缺失或长度不足 ${MIN_SECRET_LENGTH} 字符；生产环境必须显式配置强随机值`,
    );
  }
  return secret || DEV_FALLBACK_SECRET;
}
