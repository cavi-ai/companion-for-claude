FROM node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6

ARG TARGETARCH
ENV OBSIDIAN_APP_PATH=/opt/obsidian/obsidian \
    CC_E2E_ISOLATED_LINUX=1 \
    CC_E2E_ROOT=/tmp/companion-e2e/e2e-rig \
    CC_E2E_OUTPUT_DIR=/e2e-output \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 libgtk-3-0t64 libnotify4 libsecret-1-0 libxss1 libxtst6 x11-utils xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.32.1

RUN case "$TARGETARCH" in \
      amd64) archive=obsidian-1.15.0.tar.gz; checksum=75594ae09914ca0191dde13c0697dee653322287a3a806c15519332d9ada14d3 ;; \
      arm64) archive=obsidian-1.15.0-arm64.tar.gz; checksum=7e1bdd82fc65dcc3c03de5b8a85a8d79258f94642ba27987c2d1188b9763e903 ;; \
      *) echo "Unsupported Obsidian architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl --fail --show-error --location "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/$archive" --output /tmp/obsidian.tar.gz \
    && echo "$checksum  /tmp/obsidian.tar.gz" | sha256sum --check \
    && mkdir /opt/obsidian \
    && tar -xzf /tmp/obsidian.tar.gz --strip-components=1 -C /opt/obsidian \
    && rm /tmp/obsidian.tar.gz \
    && test -x "$OBSIDIAN_APP_PATH"

WORKDIR /workspace/obsidian-plugin
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile \
    && pnpm exec playwright install --with-deps chromium

COPY manifest.json ./
RUN dpkg --compare-versions 1.15.0 ge "$(node --print "require('./manifest.json').minAppVersion")"

COPY e2e/rig/run-container.sh /usr/local/bin/companion-e2e
RUN chmod +x /usr/local/bin/companion-e2e
ENTRYPOINT ["dbus-run-session", "--", "/usr/local/bin/companion-e2e"]
