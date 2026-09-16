FROM mcr.microsoft.com/devcontainers/base:debian

# deno, pinned to the latest release as of 2026-09-13 (sha256-verified).
# Installed from GitHub releases — ghcr.io anonymous token issuance is 403
# from this network, so the GHCR feature form is not an option here.
ARG DENO_VERSION=2.9.6
ARG DENO_SHA256=394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o /tmp/deno.zip \
  && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum -c - \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && rm /tmp/deno.zip \
  && deno --version

# The base image's `vscode` user (uid 1000) is the non-root user;
# updateRemoteUserUID rewrites its uid/gid to the host user's, so
# bind-mounted writes land as the local user, never root.
USER vscode
WORKDIR /workspaces/kosmozoo
