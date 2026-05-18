# Railway production image.
#
# Bypass Nixpacks because the apt-package install for LibreOffice wasn't
# sticking in the Nixpacks layer cache — the worker portal kept seeing
# raw .docx bytes hit pdfjs as InvalidPDFException. A Dockerfile gives
# us explicit control and guarantees the libreoffice binary is on PATH.

FROM node:22-bookworm-slim

# System packages, two reasons:
#  - libreoffice-*  : convert admin-uploaded .docx / .pptx / .xlsx → PDF
#                     server-side via lib/docx-to-pdf.js
#  - libcairo2 / libpango / libjpeg / libgif / librsvg : runtime deps for
#                     node-canvas (lib/pdf-render.js for the docket flow)
#  - fonts-*        : sane substitutes when Word fonts aren't embedded —
#                     keeps converted PDFs from looking like garbage
#  - build deps     : python + build-essential + pkg-config + libsqlite3-dev
#                     so native npm packages (better-sqlite3, sqlite3,
#                     canvas) can rebuild against the system libs if
#                     prebuilt binaries aren't available for this glibc
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-core \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc \
    fonts-liberation \
    fonts-dejavu \
    fonts-noto-color-emoji \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libsqlite3-dev \
    python3 \
    build-essential \
    pkg-config \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Litestream — streams the SQLite WAL to S3/R2 so a disk loss doesn't
# take the business down. See litestream.yml + start.sh for wiring. The
# binary is a single static Go executable, no runtime deps.
ARG LITESTREAM_VERSION=0.3.13
RUN ARCH=$(dpkg --print-architecture) \
 && case "$ARCH" in \
      amd64) LS_ARCH=amd64 ;; \
      arm64) LS_ARCH=arm64 ;; \
      *)     echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${LS_ARCH}.tar.gz" \
 && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
 && rm /tmp/litestream.tar.gz \
 && litestream version

WORKDIR /app

# Cache the npm install layer separately from the rest of the source so
# code-only changes don't trigger a re-install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source
COPY . .

# Litestream config lives at /etc/litestream.yml so the binary picks it
# up by default. Kept in the repo (no secrets — only env-var references)
# so the config is version-controlled alongside the migrations it backs up.
RUN cp /app/litestream.yml /etc/litestream.yml \
 && chmod +x /app/start.sh

ENV NODE_ENV=production

# Railway provides PORT — server.js reads it via process.env.PORT.
# start.sh decides whether to launch under Litestream based on
# LITESTREAM_BUCKET being set.
CMD ["/app/start.sh"]
