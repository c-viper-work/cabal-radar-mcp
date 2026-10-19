FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
ENV NODE_ENV=production
ENTRYPOINT ["node", "bin/cabal-radar.js", "--mcp"]
