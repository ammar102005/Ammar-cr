FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
EXPOSE 3000
CMD ["node","dist/main.js"]
