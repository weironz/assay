/**
 * AUTH_SECRET 启动期校验，better-auth（auth.ts）与员工文件模块
 * （web-session-scope.ts）共用同一入口，避免同一配置两处行为不一致。
 *
 * 该密钥用于会话 Cookie 签名、OAuth state、2FA 密钥加密等安全边界：
 * - 生产环境缺失、长度不足 32 字符、命中公开占位值或明显低熵时直接抛错，
 *   拒绝启动；只比较长度不够——运维复制模板忘记改值时，服务必须起不来；
 * - 其他环境允许占位密钥，保证本地起得来，但不再使用硬编码默认值兜底生产。
 */
const MIN_SECRET_LENGTH = 32;
const DEV_FALLBACK_SECRET = 'dev_secret_change_me_not_for_production';

/** 仓库模板与历史默认值：公开即高危，任何命中都视为“没改” */
const KNOWN_PLACEHOLDER_SECRETS = [
  'change_me_in_prod_please_use_long_random_string',
  'CHANGE_ME_long_random_secret',
  DEV_FALLBACK_SECRET,
];

function isPlaceholderSecret(secret: string): boolean {
  return (
    KNOWN_PLACEHOLDER_SECRETS.includes(secret) ||
    /^change[ _-]?me/i.test(secret) ||
    /^dev[ _-]?secret/i.test(secret)
  );
}

/** 重复字符堆出来的长串不是强随机：字符表过小即视为低熵弱密钥 */
function isLowEntropySecret(secret: string): boolean {
  return new Set(secret).size < 10;
}

export function requireAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    if (process.env.NODE_ENV !== 'production') return secret;
    if (isPlaceholderSecret(secret) || isLowEntropySecret(secret)) {
      throw new Error(
        'AUTH_SECRET 仍是仓库公开的占位值或低熵弱密钥，生产环境禁止使用；' +
          '请生成强随机值：openssl rand -base64 48',
      );
    }
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `AUTH_SECRET 缺失或长度不足 ${MIN_SECRET_LENGTH} 字符；生产环境必须显式配置强随机值` +
        '（openssl rand -base64 48）',
    );
  }
  return secret || DEV_FALLBACK_SECRET;
}
