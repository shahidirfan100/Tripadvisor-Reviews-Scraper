FROM apify/actor-node-playwright-chrome:22

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --legacy-peer-deps \
    && node -e "import('impit').then(m => console.log('impit OK:', Object.keys(m)))" \
    && node -e "import('patchright').then(m => console.log('patchright OK:', Object.keys(m)))" \
    && rm -rf ~/.npm

COPY . ./

ENV APIFY_LOG_LEVEL=INFO

CMD npm start --silent
