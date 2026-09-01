# ===== 后端生产镜像：多阶段构建 =====

# ---- 构建阶段：装全量依赖并编译 TS ----
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json ./
COPY prisma ./prisma
RUN pnpm install --ignore-scripts && pnpm prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
# 同时产出 dist/main.js 与 dist/seed.js（seed 已移入 src，不再需要运行时的 ts-node）
RUN pnpm build

# ---- 运行阶段：只装生产依赖 ----
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY prisma ./prisma
# install 与 generate 合并为一层：分两层会把整个 node_modules 再复制一份进镜像
RUN pnpm install --prod --ignore-scripts \
 && pnpm prisma generate \
 # generate 完成后清掉运行时用不到的东西：
 # typescript 是 prisma 的可选 peer 依赖被顺带装进来的，跑编译好的 JS 不需要它
 && rm -rf node_modules/.pnpm/typescript@* \
 && find node_modules -name '*.d.ts' -delete \
 && find node_modules -name '*.js.map' -delete \
 && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs \) -prune -exec rm -rf {} + \
 && pnpm store prune \
 && rm -rf /root/.cache /root/.npm /root/.local /tmp/*

COPY --from=builder /app/dist ./dist

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动：应用迁移 → 灌种子(幂等) → 启动服务
# 直接调二进制而不经 pnpm：启动时不必再解析 corepack/pnpm，也不会因缓存被清而回退到别的 pnpm 版本。
# 迁移失败必须中止（schema 不对不该带病启动）；种子失败可容忍（幂等、可重跑）。
# exec 让 node 成为 PID 1，容器停止时能正确收到 SIGTERM 优雅退出。
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && { node dist/seed.js || true; } && exec node dist/main.js"]
