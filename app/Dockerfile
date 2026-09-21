# Build from the REPO ROOT, not from app/:
#   docker build -f app/Dockerfile -t dark-factory-playground .
# The build needs the root package.json and lockfile because this is an npm
# workspace; app/ alone is not installable.

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY app/package.json ./app/
COPY factory/package.json ./factory/
RUN npm ci --workspace @factory/app --include-workspace-root
COPY tsconfig.base.json ./
COPY app ./app
RUN npm run build --workspace @factory/app

FROM nginx:alpine AS runtime
RUN rm -f /etc/nginx/conf.d/default.conf
COPY app/nginx.conf /etc/nginx/conf.d/app.conf
COPY --from=build /repo/app/dist /usr/share/nginx/html

# nginx:alpine ships an unprivileged `nginx` user. Give it the directories it
# needs to write at runtime so the container can drop root.
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
