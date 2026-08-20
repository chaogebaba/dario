# syntax=docker/dockerfile:1.7

# `canary`, not 1.4.0: bun.lock needs 1.4.x to parse and 1.4.0 has never been
# released, so oven/bun:1.4.0-alpine 404s and this image could not be built at
# all. Move to the release tag once 1.4.0 ships.
FROM oven/bun:canary-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
RUN bun run build

FROM oven/bun:canary-alpine AS runtime

# su-exec is the alpine package that lets the entrypoint drop privileges
# from root → dario after the volume self-heal. ~10KB; no shell, no PAM.
RUN apk add --no-cache su-exec

# Bun IS the runtime — dario requires it for the Claude Code TLS
# fingerprint and for fetch's proxy option (egress routing). The base
# image already ships it, so there is no separate binary to copy and no
# Node in the image at all.

RUN addgroup -S dario \
 && adduser -S -G dario -h /home/dario dario \
 && mkdir -p /home/dario/.dario \
 && chown -R dario:dario /home/dario

WORKDIR /app
COPY --from=build --chown=dario:dario /app/dist ./dist
# Doctor reads package.json (at __dirname/..) to surface the running version.
# Without this copy, container deploys see `[WARN] dario package.json not
# readable — version unknown` even though the binary itself works fine.
COPY --from=build --chown=dario:dario /app/package.json ./package.json

# Expose `dario` on PATH so `docker exec <container> dario login --manual`
# works. The shebang in cli.ts (`#!/usr/bin/env bun`) handles the rest.
RUN chmod +x /app/dist/cli.js \
 && ln -s /app/dist/cli.js /usr/local/bin/dario

# Self-heal entrypoint: starts as root, chowns the mounted config volume to
# dario:dario, then drops privileges via su-exec before running the CLI.
# Required because Docker volume mounts don't inherit the build-time chown,
# and any prior `--user 0` recovery op leaves the volume root-owned. Without
# this the dario user can't write credentials and the container drifts into
# a state that looks like an OAuth bug. See entrypoint script for details.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Default to the unprivileged dario user. The entrypoint detects this and
# exec's directly without chown/su-exec, which is what makes the image
# compatible with hardened compose configs that use `cap_drop: ALL` (these
# strip CAP_CHOWN AND CAP_SETUID/SETGID, so neither chown nor su-exec can
# succeed regardless of whether the container starts as root).
#
# Operators who want the self-heal entrypoint to actually chown the volume
# (e.g. after a `docker run --user 0 ...` recovery op left files root-owned)
# override the user explicitly: `docker run --user 0 ...` AND provide
# `cap_add: [CHOWN, SETUID, SETGID, FOWNER]` for that one boot. The
# entrypoint will then chown, su-exec down to dario, and from then on the
# volume is correctly owned again so normal cap-dropped starts work.
USER dario

ENV DARIO_HOST=0.0.0.0 \
    DARIO_PORT=3456

EXPOSE 3456
VOLUME ["/home/dario/.dario"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${DARIO_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["proxy"]
