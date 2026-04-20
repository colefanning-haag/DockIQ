FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY collect.mjs ./

ENV DB_PATH=/data/dockiq.db

RUN mkdir -p /data

CMD ["node", "collect.mjs"]
