# 构建：npm ci → tsc；运行镜像只含 dist + 生产依赖 + config + migrations + scripts + 门户静态产物
FROM node:20-slim AS build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# 门户前端：vite 构建静态产物（vue-tsc 类型检查随 npm run build 一起执行）
FROM node:20-slim AS build-web
WORKDIR /webbuild
COPY web/package.json web/package-lock.json ./
COPY .npmrc ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY --from=build /build/dist ./dist
COPY --from=build-web /webbuild/dist ./web/dist
COPY config ./config
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
