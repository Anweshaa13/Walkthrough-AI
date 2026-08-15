FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3001
ENV HEADLESS=true

EXPOSE 3001

CMD ["node", "server.js"]
