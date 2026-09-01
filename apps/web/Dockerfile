# ===== 前端生产镜像：Bun 构建 → Nginx 托管静态文件 =====

# ---- 构建阶段：Bun 1.4.0 ----
FROM oven/bun:1.4.0-alpine AS builder
WORKDIR /app

# 先只拷依赖清单，命中缓存后源码改动不必重装依赖
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY . .
# 单域名部署：API 走相对路径 /api（由 Nginx 反代），故 base 留空
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN bun run build

# ---- 运行阶段：alpine-slim（不含 perl/geoip 等用不到的模块）----
FROM nginx:1.27-alpine-slim
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
