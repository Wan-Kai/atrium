# The phone relay (SPEC-0005, "部署 relay"). Build the bundle first, then the image from apps/relay:
#
#   pnpm --filter @atrium/relay build
#   docker buildx build --platform linux/amd64 -t atrium-relay:<version> --load apps/relay
#
# The bundle is one platform-independent file made from the locked workspace on the developer's
# machine; installing packages inside `docker build` fetched the whole workspace's metadata and dev
# tools at a few KiB/s (2026-10-25). The first stage runs the bundle on the exact Node of the image
# before it is shipped; the second is only the official Node image, the file and an unprivileged
# user. See apps/relay/README.md.

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS check
COPY dist/relay.cjs /app/relay.cjs
# A data directory with a config: add-host must print one atrium-relay:// line and list-hosts must
# read the table back, so a bundle that does not load or run on this Node fails the build.
RUN mkdir /tmp/check \
 && echo '{"publicHost":"relay.check","pathPrefix":"/atrium"}' > /tmp/check/relay.json \
 && node /app/relay.cjs add-host check --dir /tmp/check | grep -Eq '^atrium-relay://hst_[0-9a-f]{16}:[A-Za-z0-9_-]{43}@relay\.check/atrium$' \
 && node /app/relay.cjs list-hosts --dir /tmp/check | grep -q 'check'

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="atrium-relay" \
      org.opencontainers.image.description="Atrium's phone relay: forwards Noise-encrypted bytes between a Mac and its phones"
ENV NODE_ENV=production \
    ATRIUM_RELAY_DIR=/data \
    ATRIUM_RELAY_LISTEN=0.0.0.0:8787
WORKDIR /app
COPY --from=check /app/relay.cjs /app/relay.cjs
# The official image's unprivileged user (uid 1000); the data directory must be writable by it.
USER node
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["node", "/app/relay.cjs"]
CMD ["serve"]
