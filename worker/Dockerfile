FROM node:20-alpine
WORKDIR /app
COPY worker/package.json ./
RUN npm install --omit=dev
COPY worker/ .
COPY shared/ ./shared/
EXPOSE 9464
CMD ["node","worker.js"]