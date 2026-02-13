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

CMD ["node", "--experimental-sqlite", "--max-old-space-size=500", "src/main.mjs"]
