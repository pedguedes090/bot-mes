FROM node:22-slim AS runtime

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ src/

# Non-root user
RUN groupadd -r bot && useradd -r -g bot bot
USER bot

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:9090/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Resource hints (advisory)
# Set in docker run: --memory=128m --cpus=1
# GC tuning for low-memory: --max-old-space-size=96

ENV NODE_OPTIONS="--max-old-space-size=96 --expose-gc"

CMD ["node", "--experimental-sqlite", "src/main.mjs"]
