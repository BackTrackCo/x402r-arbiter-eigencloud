FROM node:22-slim

RUN npm install -g pnpm@latest

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .
RUN pnpm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
