FROM registry-1.docker.io/cloudflare/sandbox@sha256:862aa35be41b1b56bc27acd66931c8ae668fce12ed401ecb2e5a83bcde41a3e6

USER root
WORKDIR /opt/delivery-agent

RUN npm install --global pnpm@11.5.2

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --config.optional=false

RUN codex_url='https://registry.npmmirror.com/@openai/codex/-/codex-0.145.0-linux-x64.tgz' \
    && codex_tgz='/tmp/codex-linux-x64.tgz' \
    && attempt=0 \
    && until curl --fail --location --silent --show-error \
         --connect-timeout 30 --max-time 300 --continue-at - \
         --output "$codex_tgz" "$codex_url"; do \
       attempt=$((attempt + 1)); \
       test "$attempt" -lt 5 || exit 1; \
     done \
    && echo 'bbcc3c2cbbf70efb1fac30a8b302c87a66744a83445f28b9d755ac7c5b1289851ace4f6a32c07f36d53c37dbe101f37b9990312c5a0c7b1e2feba2631ee656c0  /tmp/codex-linux-x64.tgz' \
       | sha512sum --check --strict \
    && mkdir -p /opt/delivery-agent/node_modules/@openai/codex-linux-x64 \
    && tar -xzf "$codex_tgz" \
         -C /opt/delivery-agent/node_modules/@openai/codex-linux-x64 \
         --strip-components=1 \
    && rm "$codex_tgz" \
    && esbuild_url='https://registry.npmmirror.com/@esbuild/linux-x64/-/linux-x64-0.28.1.tgz' \
    && esbuild_tgz='/tmp/esbuild-linux-x64.tgz' \
    && attempt=0 \
    && until curl --fail --location --silent --show-error \
         --connect-timeout 30 --max-time 300 --continue-at - \
         --output "$esbuild_tgz" "$esbuild_url"; do \
       attempt=$((attempt + 1)); \
       test "$attempt" -lt 5 || exit 1; \
     done \
    && echo 'bbf6a73581769a654e103c0bb67435c0eaf7119f6c4cd18b5abb18198c075b3180dd28bce083a41d795b5930f5341fbdff595c9f079828ee78ba1c59c9d3737c  /tmp/esbuild-linux-x64.tgz' \
       | sha512sum --check --strict \
    && mkdir -p /opt/delivery-agent/node_modules/@esbuild/linux-x64 \
    && tar -xzf "$esbuild_tgz" \
         -C /opt/delivery-agent/node_modules/@esbuild/linux-x64 \
         --strip-components=1 \
    && rm "$esbuild_tgz" \
    && pnpm exec tsx -e 'const value: number = 1; if (value !== 1) process.exit(1)' \
    && test -x /opt/delivery-agent/node_modules/.bin/codex \
    && /opt/delivery-agent/node_modules/.bin/codex --version

# Go toolchain for Go target repositories (tipsy-backend pins go 1.25.0 in
# go.mod). Without it `go mod download` fails as command-not-found before the
# agent runs at all, so a Go repository cannot be delivered.
#
# Checksum is the SHA-256 published on go.dev; the entries above use SHA-512
# because npmmirror publishes that instead. Match whatever the source publishes
# rather than rehashing a downloaded artifact, which would only prove the bytes
# hash to themselves.
#
# GOFLAGS pins module mode and GOTOOLCHAIN=local stops the toolchain from
# silently downloading a different version at build time on a sandbox that may
# have no egress.
#
# gcc/libc6-dev are required, not optional: the base image ships no C compiler and
# CGO_ENABLED=0, so every cgo package fails to compile with bare "undefined:"
# symbol errors that look like a broken dependency rather than a missing
# toolchain. tipsy-backend depends on github.com/chai2010/webp (a cgo package) in
# go.mod, so its service package cannot build without this. Measured: with gcc
# present, `go build ./service` succeeds in 446s; without it, the build fails.
#
# `--no-install-recommends gcc libc6-dev` is deliberately narrower than
# build-essential, which also pulls make, g++, dpkg-dev and perl that Go never
# invokes. The minimal pair was verified sufficient (cgo build of
# ./cmd/smoketest/... succeeded in 95s) and costs ~8 MB of package metadata.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
         gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* \
    && gcc --version | head -1

RUN go_url='https://go.dev/dl/go1.25.0.linux-amd64.tar.gz' \
    && go_tgz='/tmp/go-linux-amd64.tar.gz' \
    && attempt=0 \
    && until curl --fail --location --silent --show-error \
         --connect-timeout 30 --max-time 600 --continue-at - \
         --output "$go_tgz" "$go_url"; do \
       attempt=$((attempt + 1)); \
       test "$attempt" -lt 5 || exit 1; \
     done \
    && echo '2852af0cb20a13139b3448992e69b868e50ed0f8a1e5940ee1de9e19a123b613  /tmp/go-linux-amd64.tar.gz' \
       | sha256sum --check --strict \
    && tar -xzf "$go_tgz" -C /usr/local \
    && rm "$go_tgz" \
    && /usr/local/go/bin/go version

# CGO_ENABLED=1 is required alongside gcc: the base image defaults it to 0, and
# with cgo disabled a cgo package still compiles its Go half, then fails on the
# C-backed symbols it can no longer see. Installing a compiler without flipping
# this would leave the original failure exactly as it was.
ENV PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod \
    CGO_ENABLED=1

# Warm the Go module cache for the Go pilot repository.
#
# Measured on a standard-4 equivalent against a real checkout, the cost is almost
# entirely dependency download, not compilation:
#
#   go mod download                     102s   (1.7 GiB module cache)
#   go build ./cmd/smoketest/…  cold      60s
#   go build ./cmd/smoketest/…  warm       1s
#
# So a fresh sandbox pays ~100s per attempt to fetch modules it could have
# shipped with, and then compiles in about a second. Baking the cache trades
# image size for that per-attempt cost.
#
# Only go.mod/go.sum are fetched (about 115 KB), never a checkout: the sandbox
# still clones the repository at the trusted dispatch base SHA, and this layer
# must not become a second, staler source of repository content. If the manifests
# move on, `go mod download` at run time simply fetches the delta.
#
# The pilot repository is private, so fetching its manifests needs a token. It
# arrives as a BuildKit secret mount, which is readable only inside this one RUN
# and is never written to an image layer or to build history — unlike an ARG,
# which would be recoverable from the built image. The modules it then downloads
# are public (including the Lightspeed-Intelligence SDKs), so nothing
# credentialed ends up in the cache.
#
# The layer is best-effort. This image's primary job is the Node toolchain, so a
# missing token or a fetch failure must not fail the build: it warns, exits 0,
# and a cold sandbox simply pays the original ~100s. Build without the secret and
# you still get a working image, just an unwarmed one.
ARG GO_PILOT_REPOSITORY=lightspeed-intelligence/tipsy-backend
ARG GO_PILOT_REF=master
RUN --mount=type=secret,id=github_token \
    set -eu; \
    warm=/tmp/go-pilot-warm; mkdir -p "$warm"; cd "$warm"; \
    token=''; \
    if [ -r /run/secrets/github_token ]; then token="$(cat /run/secrets/github_token)"; fi; \
    if [ -z "$token" ]; then \
      echo 'WARNING: no github_token secret; skipping module cache warm'; \
      rm -rf "$warm"; exit 0; \
    fi; \
    api="https://api.github.com/repos/${GO_PILOT_REPOSITORY}/contents"; \
    fetched=1; \
    for f in go.mod go.sum; do \
      curl --fail --location --silent --show-error --connect-timeout 30 --max-time 120 \
        -H "authorization: Bearer $token" \
        -H 'accept: application/vnd.github.raw' \
        -o "$f" "$api/$f?ref=${GO_PILOT_REF}" || fetched=0; \
    done; \
    if [ "$fetched" -eq 1 ] && go mod download; then \
      echo "warmed module cache: $(du -sh /root/go/pkg/mod | cut -f1)"; \
    else \
      echo 'WARNING: manifest fetch or module download failed; sandboxes fetch at run time'; \
    fi; \
    rm -rf "$warm"; \
    exit 0

COPY tsconfig.json ./
COPY src ./src
COPY scripts/run-analysis-attempt.ts scripts/run-execution-attempt.ts \
     scripts/run-publisher-attempt.ts ./scripts/
COPY executor-image/run-execution.mjs ./bin/run-execution

RUN chmod 0555 /opt/delivery-agent/bin/run-execution
