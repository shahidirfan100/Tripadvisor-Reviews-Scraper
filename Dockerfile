FROM apify/actor-node:22

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
