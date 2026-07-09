# ===== 生产镜像：构建静态资源 → Nginx 托管 =====
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install
COPY . .
# 单域名部署：API 走相对路径 /api（由 Nginx 反代），故 base 留空
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
