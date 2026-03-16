FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/data

EXPOSE 7860

CMD ["sh", "-c", "node src/seed.js && node src/server.js"]