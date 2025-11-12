# ---- build stage (amd64) ----
FROM --platform=linux/amd64 node:22-bookworm-slim AS build
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .

# ---- runtime stage (distroless) ----
FROM --platform=linux/amd64 gcr.io/distroless/nodejs22-debian12:nonroot
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=nonroot:nonroot --from=build /app /app
EXPOSE 3000
# Start the Express entry point directly
CMD ["./bin/www"]
