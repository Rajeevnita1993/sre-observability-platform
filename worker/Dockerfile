FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 9464

# Run worker.js as main process
CMD ["node", "worker.js"]
