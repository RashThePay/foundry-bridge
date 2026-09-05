FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=3847 BRIDGE_DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/bridge ./bridge
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 3847
VOLUME ["/data"]
CMD ["node", "bridge/server.mjs"]
