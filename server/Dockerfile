FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Which commit this image is, reported unauthenticated by /healthz so a deploy
# can be checked without shell access on the host. Baked in at build time rather
# than read from .git at runtime: there is no repo in the container, and a sha
# the image cannot have got from anywhere but its own build is the point.
#
# Declared here, after npm ci, so changing it does not invalidate the dependency
# layer. Both default to empty, and empty is reported as null rather than as a
# missing field -- see server/src/build.ts.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

# Runs unprivileged; nothing here needs root.
USER node
EXPOSE 8787

# The gateway is stateless apart from Postgres, so liveness is just "can it serve".
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
