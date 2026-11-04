# Build from the repository root: docker build -f services/data-api/Dockerfile .
FROM node:26-slim AS build
WORKDIR /repo
RUN npm install -g pnpm@12.16.1
COPY . .
RUN pnpm install --frozen-lockfile --filter "@qhint/data-api..." --filter qhint
RUN node scripts/build-service.mjs data-api
RUN pnpm --filter @qhint/data-api deploy --prod --legacy --config.node-linker=hoisted /out

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/services/data-api/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
