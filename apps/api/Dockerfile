# ===== 生产镜像：多阶段构建 =====
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json ./
COPY prisma ./prisma
RUN pnpm install
COPY . .
RUN pnpm prisma generate && pnpm build

FROM node:22-alpine AS runner
RUN apk add --no-cache openssl && corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json tsconfig.json ./
COPY prisma ./prisma
# 仅装生产依赖（prisma CLI / ts-node 已在 dependencies）
RUN pnpm install --prod
RUN pnpm prisma generate
COPY --from=builder /app/dist ./dist

EXPOSE 3000
# 启动：应用迁移 → 灌种子(幂等) → 启动
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm db:seed || true; node dist/main.js"]
