# 城市慢行站 · 季节年历服务
FROM node:20-slim
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY *.html ./
COPY css/ ./css/
COPY js/ ./js/
RUN mkdir -p /data
ENV PORT=3000 DB_FILE=/data/calendar.sqlite
EXPOSE 3000
CMD ["node", "server/index.js"]
