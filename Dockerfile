FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV MAX_UPLOAD_MB=500
ENV RESULT_TTL_MINUTES=10
ENV MAX_CONCURRENT_JOBS=1

RUN mkdir -p /tmp/danzclean-tiktok

EXPOSE 3000

CMD ["npm", "start"]
