FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json vitest.config.ts .
COPY src ./src
COPY config.yaml ./config.yaml
COPY README.md ./README.md

RUN npm install
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/cli.js", "start", "--config", "config.yaml"]
