FROM node:20-slim
WORKDIR /app

# 编译 sqlite3 原生模块所需工具（node:20-slim 不包含）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# 数据目录：Hugging Face Spaces 会将持久存储挂载到 /data
RUN mkdir -p /data
ENV DB_PATH=/data/xiaomubiao.db
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "src/index.js"]
