# Stage 1: build static/styles.css with the Tailwind standalone CLI (no npm).
FROM debian:bookworm-slim AS css
ARG TARGETARCH
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
		arm64) suffix=linux-arm64 ;; \
		*) suffix=linux-x64 ;; \
	esac \
	&& curl -fsSL -o /usr/local/bin/tailwindcss \
		"https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.0/tailwindcss-${suffix}" \
	&& chmod +x /usr/local/bin/tailwindcss
WORKDIR /build
COPY tailwind.css ./
COPY web ./web
RUN tailwindcss -i tailwind.css -o styles.css --minify

# Stage 2: the app. The deno user (uid 1993) owns the cache and the jobs volume.
FROM denoland/deno:2.7.14
WORKDIR /app
RUN mkdir /data && chown deno:deno /data /app
USER deno

COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno engine ./engine
COPY --chown=deno:deno web ./web
COPY --chown=deno:deno static ./static
COPY --from=css --chown=deno:deno /build/styles.css ./static/styles.css
RUN deno cache web/server.ts engine/scrape.ts

ENV DATA_DIR=/data
EXPOSE 8000
CMD ["task", "serve"]
