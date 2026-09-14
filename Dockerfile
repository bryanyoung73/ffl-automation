FROM node:22-alpine

WORKDIR /app

# The dashboard never drives a browser (that's Yahoo-only, and this container
# is meant for PROVIDER=espn/sleeper) — skip @playwright/test's browser
# download so the image doesn't pull down a Chromium it will never use.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Real config/secrets come from the environment (docker-compose env_file),
# never baked into the image — env_file sets process.env directly, so
# config.ts's env.example -> .env fallback (for a bare local run with no
# .env at all) never triggers here and env.example needn't be in the image.
# See docker-compose.yml.
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=4173
EXPOSE 4173

CMD ["npx", "tsx", "src/cli/serve.ts"]
