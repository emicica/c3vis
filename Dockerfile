# ---- build stage ----
FROM node:22-bookworm-slim AS build
ENV NODE_ENV=production
WORKDIR /app

# carry only files needed for install first (cache efficiency)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# now copy the rest of the app
COPY . .

# ---- runtime stage ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# create non-root user
RUN useradd -r -u 1001 nodeuser

# copy files and give ownership to the non-root user
COPY --chown=nodeuser:nodeuser --from=build /app /app

USER nodeuser
EXPOSE 3000

# IMPORTANT: start the app directly to avoid npm lifecycle scripts
CMD ["node", "./bin/www"]
