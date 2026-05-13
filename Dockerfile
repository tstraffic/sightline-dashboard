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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cache the npm install layer separately from the rest of the source so
# code-only changes don't trigger a re-install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source
COPY . .

ENV NODE_ENV=production

# Railway provides PORT — server.js reads it via process.env.PORT.
CMD ["npm", "start"]
