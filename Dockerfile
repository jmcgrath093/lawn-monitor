FROM node:22-alpine

# better-sqlite3 ships prebuilt binaries for alpine/musl on node 22,
# but keep build tools available as a fallback for other architectures.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DB_PATH=/data/lawn.db
ENV PORT=3000

VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
