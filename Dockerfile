FROM node:20-slim
WORKDIR /app

# 编译 sqlite3 原生模块所需工具（node:20-slim 不包含）
# + node-canvas（手抄报服务端合成）运行所需的原生库与中文字体（缺字体时文字会变方框）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 fonts-noto-cjk \
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
