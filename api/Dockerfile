FROM node:20-alpine
WORKDIR /app
COPY api/package.json ./
RUN npm install --omit=dev
COPY api/ .
COPY shared/ ./shared/
EXPOSE 8080 9464
CMD ["npm","start"]