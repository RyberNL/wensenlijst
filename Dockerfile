FROM node:24-alpine
WORKDIR /app
COPY server.js admin-api.js auth-lib.js user-api.js mailer.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/wensen.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
