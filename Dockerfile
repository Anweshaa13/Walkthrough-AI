FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]