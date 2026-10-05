# pi-control server
# Build:  docker build -t pi-control server/
# Run:    docker run -d --name pi-control -p 8787:8787 \
#            -e PI_REMOTE_SERVER_KEY="$(openssl rand -hex 32)" pi-control
# (For TLS, mount a cert/key and export PI_REMOTE_TLS_CERT / PI_REMOTE_TLS_KEY.)

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Run as the unprivileged "node" user provided by the base image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
