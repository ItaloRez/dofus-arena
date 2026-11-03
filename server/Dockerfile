FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8090 DB_FILE=/data/db.json
VOLUME /data
EXPOSE 8090
CMD ["node", "src/server.js"]
