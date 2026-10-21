FROM docker.io/library/debian:bookworm-slim AS system
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(dpkg --print-architecture)" = amd64 \
    && ln -s /usr/lib/x86_64-linux-gnu/libsqlite3.so.0 /usr/lib/libsqlite3.so

# Same verified amd64 release pin as .devcontainer/Dockerfile.
FROM system AS deno-download
ARG DENO_VERSION=2.9.6
ARG DENO_SHA256=394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o /deno.zip \
    && echo "${DENO_SHA256}  /deno.zip" | sha256sum -c - \
    && unzip /deno.zip -d /usr/local/bin \
    && rm /deno.zip

FROM system AS builder
COPY --from=deno-download /usr/local/bin/deno /usr/local/bin/deno
ENV DENO_DIR=/deno-dir DENO_SQLITE_PATH=/usr/lib/libsqlite3.so
WORKDIR /app
COPY deno.json deno.lock build.mjs ./
COPY src/ src/
COPY client/ client/
COPY client-solid/ client-solid/
COPY dev/vendor-browser.mjs dev/vendor-browser.mjs
COPY tests/ tests/
COPY plugins/ plugins/
COPY plugins/hello/*.mjs /opt/kosmozoo/plugins/hello/
COPY plugins/difference/*.mjs /opt/kosmozoo/plugins/difference/
COPY plugins/detector/*.mjs /opt/kosmozoo/plugins/detector/
COPY plugins/critic/*.mjs /opt/kosmozoo/plugins/critic/
RUN deno task deps \
    && deno run --frozen --cached-only --allow-all build.mjs \
    && deno task setup

FROM system AS runtime
COPY --from=deno-download /usr/local/bin/deno /usr/local/bin/deno
RUN groupadd --gid 1000 kosmozoo \
    && useradd --uid 1000 --gid 1000 --home-dir /data --no-create-home kosmozoo \
    && mkdir -p /data/state /data/cache \
    && chown -R kosmozoo:kosmozoo /data
WORKDIR /app
COPY --from=builder /app/src/ src/
COPY --from=builder /app/client/ client/
COPY --from=builder /app/client-solid-dist/ client-solid-dist/
COPY --from=builder /app/deno.json /app/deno.lock ./
COPY --from=builder /opt/kosmozoo/plugins/ /opt/kosmozoo/plugins/
COPY --from=builder --chown=kosmozoo:kosmozoo /deno-dir/ /deno-dir/
COPY LICENSE LICENSE.GPL /usr/share/doc/kosmozoo/
COPY packaging/linux/resources/THIRD_PARTY_NOTICES.txt packaging/linux/resources/NOTICE-SOURCES.json /usr/share/doc/kosmozoo/
COPY packaging/linux/resources/provenance.json packaging/linux/resources/provenance.json
COPY VERSION ./
ARG KOZMOZOO_REVISION=
ENV KOZMOZOO_REVISION=$KOZMOZOO_REVISION
ENV HOME=/data \
    KOZMOZOO_STATE=/data/state \
    KOZMOZOO_CACHE=/data/cache \
    KOZMOZOO_PLUGINS=/opt/kosmozoo/plugins \
    KOZMOZOO_PORT=2084 \
    KOZMOZOO_BIND=0.0.0.0 \
    KOZMOZOO_HOSTS="" \
    DENO_SQLITE_PATH=/usr/lib/libsqlite3.so \
    DENO_DIR=/deno-dir
VOLUME ["/data/state", "/data/cache"]
EXPOSE 2084
USER kosmozoo
CMD ["deno", "run", "--frozen", "--cached-only", "--allow-all", "src/main.mjs"]
