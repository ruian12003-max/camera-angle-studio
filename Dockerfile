FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json server.js index.html ./

EXPOSE 43127
CMD ["node", "server.js"]
