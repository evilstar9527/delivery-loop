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

COPY tsconfig.json ./
COPY src ./src
COPY scripts/run-analysis-attempt.ts scripts/run-execution-attempt.ts \
     scripts/run-publisher-attempt.ts ./scripts/
COPY executor-image/run-execution.mjs ./bin/run-execution

RUN chmod 0555 /opt/delivery-agent/bin/run-execution
