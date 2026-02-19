FROM node:22-slim AS builder

RUN npm install -g pnpm@latest

WORKDIR /app

# Copy package.json and strip file: linked devDeps + pnpm patches
# (only needed by the seed script, not the production server)
COPY package.json ./
RUN node -e " \
  const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
  const dev = p.devDependencies || {}; \
  for (const k of Object.keys(dev)) { \
    if (typeof dev[k] === 'string' && dev[k].startsWith('file:')) delete dev[k]; \
  } \
  delete p.pnpm; \
  require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)); \
"

# Install all deps (need typescript for build)
RUN pnpm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

# --- Production stage ---
FROM node:22-slim

RUN npm install -g pnpm@latest

WORKDIR /app

COPY package.json ./
RUN node -e " \
  const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); \
  delete p.devDependencies; \
  delete p.pnpm; \
  require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)); \
"
RUN pnpm install --prod

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
