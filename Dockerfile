FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN node scripts/fetch-logos.mjs

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
