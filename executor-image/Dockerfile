FROM registry-1.docker.io/cloudflare/sandbox@sha256:862aa35be41b1b56bc27acd66931c8ae668fce12ed401ecb2e5a83bcde41a3e6

USER root
WORKDIR /opt/delivery-agent

RUN npm install --global pnpm@11.5.2

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec tsx --version \
    && pnpm exec codex --version

COPY tsconfig.json ./
COPY src ./src
COPY scripts/run-analysis-attempt.ts scripts/run-execution-attempt.ts \
     scripts/run-publisher-attempt.ts ./scripts/
COPY executor-image/run-execution.mjs ./bin/run-execution

RUN chmod 0555 /opt/delivery-agent/bin/run-execution
