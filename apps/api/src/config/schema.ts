/**
 * 集中配置 schema。
 *
 * 约定：
 * - 所有环境变量的**唯一**读取入口在 `src/config`，业务代码不得再直接读
 *   `process.env`；
 * - 默认值与历史行为保持一致（.env / Compose env_file 仍然原样生效）；
 * - 仅对「结构错误」在启动期报错（端口、来源、URL 等），取值语义仍按原代码
 *   的宽松规则解析，避免重构改变正常配置下的运行行为；
 * - 生产环境的敏感回退（S3 凭据 rustfsadmin）在这里删除，由
 *   `assertProductionConfig` 在启动期明确拒绝，而不是静默使用公开值。
 */
import { join } from 'node:path';
import { z } from 'zod';

export type MailProvider = 'aliyun' | 'smtp' | 'none';

const DEFAULT_APP_URL = 'http://localhost:5173';

export interface AppConfig {
  nodeEnv?: string;
  isProduction: boolean;
  api: {
    port: number;
    shutdownDrainMs: number;
  };
  app: {
    /** APP_URL；未配置时与旧行为一致回退 localhost。 */
    url: string;
    /** 邮件链接使用：APP_URL → 首个可信来源 → localhost。 */
    mailLinkUrl: string;
  };
  auth: {
    baseUrl: string;
    secret?: string;
    trustedOrigins: string[];
    /** 是否显式配置了 AUTH_TRUST_ORIGINS（生产环境要求显式配置）。 */
    trustedOriginsConfigured: boolean;
    requireEmailVerification: boolean;
    registrationEnabled: boolean;
    privilegedMfaMode: 'enforce' | 'optional';
  };
  directory: {
    authEnabled: boolean;
  };
  samba: {
    enabled: boolean;
    agentUrl: string;
    agentTokenFile: string;
  };
  files: {
    enabled: boolean;
    gatewayUrl: string;
    gatewayTokenFile: string;
    uploadTmpDir: string;
  };
  redis: {
    /** 原始 REDIS_URL；未设置时为空，调用方按 HOST/PORT 组合。 */
    url?: string;
    /** 兼容旧代码的完整连接串（REDIS_URL 或默认值）。 */
    connectionUrl: string;
    host: string;
    port: number;
  };
  storage: {
    driver: string;
    localDir: string;
    s3: {
      bucket: string;
      endpoint: string;
      region: string;
      /** 生产环境必须显式配置；非生产保留 rustfsadmin 以兼容本地 RustFS。 */
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle: boolean;
    };
  };
  mail: {
    provider: MailProvider;
    smtp: {
      host?: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      from: string;
    };
    aliyun: {
      accessKeyId?: string;
      accessKeySecret?: string;
      account: string;
      region: string;
      endpoint: string;
      fromAlias?: string;
    };
  };
  admin: {
    email: string;
    /** 是否显式配置了 ADMIN_EMAIL（用于保留旧的告警行为）。 */
    emailConfigured: boolean;
    name: string;
    password?: string;
  };
  netbox: {
    baseUrl: string;
    token?: string;
  };
}

/** 空字符串在旧代码里基本等价于「未配置」（`env.X || fallback`）。 */
const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const text = () => z.preprocess(emptyToUndefined, z.string().optional());

/** 旧代码用 `=== 'true'` 判断开关；其他值一律视为 false。 */
const flag = (fallback: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value) => (value === undefined ? fallback : value === 'true')),
  );

/** 旧代码用 `(env.X || 'true') === 'true'`：只有显式 'true' 才开启。 */
const defaultTrueFlag = () =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value) => (value === undefined ? true : value === 'true')),
  );

/** 与 `Number(value) || fallback` 兼容：非法值退回默认值。 */
const port = (fallback: number) =>
  z.preprocess((value) => {
    if (value === undefined || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
  }, z.number().int().min(1).max(65535).default(fallback));

const milliseconds = (fallback: number) =>
  z.preprocess((value) => {
    if (value === undefined || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed !== 0 ? parsed : undefined;
  }, z.number().int().min(0).default(fallback));

const exactOrigin = z
  .string()
  .trim()
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error('invalid origin');
      }
      return url.origin;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: '必须是 http(s) 精确来源（不含路径、查询、参数或凭据）',
      });
      return value;
    }
  });

const trustedOrigins = z.preprocess(
  (value) => {
    const raw = emptyToUndefined(value);
    if (raw === undefined || typeof raw !== 'string') return raw;
    return raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  },
  z
    .array(exactOrigin)
    .min(1)
    .optional()
    .transform((origins) => origins ?? [DEFAULT_APP_URL]),
);

const envSchema = z.object({
  NODE_ENV: text(),
  API_PORT: port(3000),
  SHUTDOWN_DRAIN_MS: milliseconds(10_000),
  APP_URL: text(),
  AUTH_BASE_URL: text().transform((value) => value ?? 'http://localhost:3000'),
  AUTH_SECRET: text(),
  AUTH_TRUST_ORIGINS: trustedOrigins,
  REQUIRE_EMAIL_VERIFICATION: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
  ),
  AUTH_ALLOW_REGISTRATION: flag(false),
  PRIVILEGED_MFA_MODE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((value) => (value === 'enforce' ? 'enforce' : 'optional')),
  ),

  REDIS_URL: text(),
  REDIS_HOST: text().transform((value) => value ?? 'redis'),
  REDIS_PORT: port(6379),

  STORAGE_DRIVER: text().transform((value) => (value ?? 's3').toLowerCase()),
  STORAGE_LOCAL_DIR: text().transform(
    (value) => value ?? join(process.cwd(), 'storage-data'),
  ),
  UPLOAD_TMP_DIR: text().transform((value) => value ?? ''),
  S3_BUCKET: text().transform((value) => value ?? 'assay-attachments'),
  S3_ENDPOINT: text().transform((value) => value ?? 'http://rustfs:9000'),
  S3_REGION: text().transform((value) => value ?? 'us-east-1'),
  S3_ACCESS_KEY: text(),
  S3_SECRET_KEY: text(),
  S3_FORCE_PATH_STYLE: defaultTrueFlag(),

  SAMBA_ENABLED: flag(false),
  SAMBA_AGENT_URL: text().transform((value) => value ?? ''),
  SAMBA_AGENT_TOKEN_FILE: text().transform((value) => value ?? ''),
  DIRECTORY_AUTH_ENABLED: flag(false),
  FILES_ENABLED: flag(false),
  FILES_GATEWAY_URL: text().transform((value) => value ?? ''),
  FILES_GATEWAY_TOKEN_FILE: text().transform((value) => value ?? ''),

  MAIL_PROVIDER: text().transform((value) => (value ?? '').toLowerCase()),
  SMTP_HOST: text(),
  SMTP_PORT: port(587),
  SMTP_SECURE: flag(false),
  SMTP_USER: text(),
  SMTP_PASS: text(),
  SMTP_FROM: text().transform(
    (value) => value ?? '工单系统 <no-reply@example.com>',
  ),
  ALIYUN_DM_ACCESS_KEY_ID: text(),
  ALIYUN_DM_ACCESS_KEY_SECRET: text(),
  ALIYUN_DM_ACCOUNT: text().transform(
    (value) => value ?? 'noreply@mail.cloudcele.com',
  ),
  ALIYUN_DM_REGION: text().transform((value) => value ?? 'cn-hangzhou'),
  ALIYUN_DM_ENDPOINT: text().transform(
    (value) => value ?? 'https://dm.aliyuncs.com/',
  ),
  ALIYUN_DM_FROM_ALIAS: text(),

  ADMIN_EMAIL: text(),
  ADMIN_NAME: text(),
  ADMIN_PASSWORD: text(),

  NETBOX_API_BASE_URL: text().transform(
    (value) => value ?? 'https://netbox.cloudcele.com',
  ),
  NETBOX_API_TOKEN: text(),
});

/**
 * 参与缓存指纹的环境变量键。测试会运行中修改 process.env，
 * 指纹变化后必须重新校验，不能把第一次解析的结果永久缓存。
 */
export const CONFIG_ENV_KEYS = Object.keys(envSchema.shape) as Array<
  keyof z.infer<typeof envSchema>
>;

function detectMailProvider(
  explicit: string,
  aliyunKeyId: string | undefined,
  smtpHost: string | undefined,
): MailProvider {
  if (explicit === 'aliyun' || explicit === 'smtp' || explicit === 'none') {
    return explicit;
  }
  if (aliyunKeyId) return 'aliyun';
  if (smtpHost) return 'smtp';
  return 'none';
}

function formatIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`环境变量配置校验失败: ${formatIssues(result.error)}`);
  }
  const value = result.data;
  const isProduction = value.NODE_ENV === 'production';
  const provider = detectMailProvider(
    value.MAIL_PROVIDER,
    value.ALIYUN_DM_ACCESS_KEY_ID,
    value.SMTP_HOST,
  );
  // 只有非生产环境保留公开的 RustFS 本地默认值；生产环境返回 undefined，
  // 由 assertProductionConfig / 存储驱动在启动期拒绝，绝不回退 rustfsadmin。
  const accessKeyId = value.S3_ACCESS_KEY ?? (isProduction ? undefined : 'rustfsadmin');
  const secretAccessKey =
    value.S3_SECRET_KEY ?? (isProduction ? undefined : 'rustfsadmin');
  const appUrl = value.APP_URL ?? DEFAULT_APP_URL;
  const trustedOriginsConfigured =
    typeof env.AUTH_TRUST_ORIGINS === 'string' &&
    env.AUTH_TRUST_ORIGINS.trim() !== '';

  return {
    nodeEnv: value.NODE_ENV,
    isProduction,
    api: {
      port: value.API_PORT,
      shutdownDrainMs: value.SHUTDOWN_DRAIN_MS,
    },
    app: {
      url: appUrl,
      mailLinkUrl: value.APP_URL ?? value.AUTH_TRUST_ORIGINS[0] ?? appUrl,
    },
    auth: {
      baseUrl: value.AUTH_BASE_URL,
      secret: value.AUTH_SECRET,
      trustedOrigins: value.AUTH_TRUST_ORIGINS,
      trustedOriginsConfigured,
      requireEmailVerification:
        value.REQUIRE_EMAIL_VERIFICATION ?? provider !== 'none',
      registrationEnabled: value.AUTH_ALLOW_REGISTRATION,
      privilegedMfaMode: value.PRIVILEGED_MFA_MODE,
    },
    directory: {
      authEnabled: value.DIRECTORY_AUTH_ENABLED,
    },
    samba: {
      enabled: value.SAMBA_ENABLED,
      agentUrl: value.SAMBA_AGENT_URL,
      agentTokenFile: value.SAMBA_AGENT_TOKEN_FILE,
    },
    files: {
      enabled: value.FILES_ENABLED,
      gatewayUrl: value.FILES_GATEWAY_URL,
      gatewayTokenFile: value.FILES_GATEWAY_TOKEN_FILE,
      uploadTmpDir: value.UPLOAD_TMP_DIR,
    },
    redis: {
      url: value.REDIS_URL,
      connectionUrl: value.REDIS_URL ?? 'redis://redis:6379',
      host: value.REDIS_HOST,
      port: value.REDIS_PORT,
    },
    storage: {
      driver: value.STORAGE_DRIVER,
      localDir: value.STORAGE_LOCAL_DIR,
      s3: {
        bucket: value.S3_BUCKET,
        endpoint: value.S3_ENDPOINT,
        region: value.S3_REGION,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: value.S3_FORCE_PATH_STYLE,
      },
    },
    mail: {
      provider,
      smtp: {
        host: value.SMTP_HOST,
        port: value.SMTP_PORT,
        secure: value.SMTP_SECURE,
        user: value.SMTP_USER,
        pass: value.SMTP_PASS,
        from: value.SMTP_FROM,
      },
      aliyun: {
        accessKeyId: value.ALIYUN_DM_ACCESS_KEY_ID,
        accessKeySecret: value.ALIYUN_DM_ACCESS_KEY_SECRET,
        account: value.ALIYUN_DM_ACCOUNT,
        region: value.ALIYUN_DM_REGION,
        endpoint: value.ALIYUN_DM_ENDPOINT,
        fromAlias: value.ALIYUN_DM_FROM_ALIAS,
      },
    },
    admin: {
      email: value.ADMIN_EMAIL ?? 'admin@example.com',
      emailConfigured: value.ADMIN_EMAIL !== undefined,
      name: value.ADMIN_NAME ?? '系统管理员',
      password: value.ADMIN_PASSWORD,
    },
    netbox: {
      baseUrl: value.NETBOX_API_BASE_URL,
      token: value.NETBOX_API_TOKEN,
    },
  };
}

/**
 * 生产环境启动期硬性约束：可信来源必须显式配置，S3 驱动不得使用公开回退凭据。
 * 放在独立函数里而不是 zod refine，是为了让单测/局部模块在 NODE_ENV=production
 * 下仍能只校验自己关心的配置；真正的启动入口（ConfigModule.validate）会调用它。
 */
export function assertProductionConfig(config: AppConfig): void {
  if (!config.isProduction) return;
  const problems: string[] = [];
  if (!config.auth.trustedOriginsConfigured) {
    problems.push(
      'AUTH_TRUST_ORIGINS 必须在生产环境显式配置（禁止回退 localhost 开发来源）',
    );
  }
  if (config.storage.driver === 's3') {
    if (!config.storage.s3.accessKeyId) {
      problems.push(
        'S3_ACCESS_KEY 未配置（生产环境禁止回退公开的 rustfsadmin）',
      );
    }
    if (!config.storage.s3.secretAccessKey) {
      problems.push(
        'S3_SECRET_KEY 未配置（生产环境禁止回退公开的 rustfsadmin）',
      );
    }
  }
  if (problems.length) {
    throw new Error(`生产环境配置校验失败: ${problems.join('; ')}`);
  }
}
