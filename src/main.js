import { Actor, log } from 'apify';
import { Impit } from 'impit';
import { chromium } from 'patchright';

const TRIPADVISOR_ORIGIN = 'https://www.tripadvisor.com';
const TRIPADVISOR_GRAPHQL_ENDPOINT = `${TRIPADVISOR_ORIGIN}/data/graphql/ids`;
const TRIPADVISOR_LOCALE = 'en-US';
const CONFIGURED_REVIEW_QUERY_ID = process.env.TRIPADVISOR_REVIEWS_QUERY_ID;
const TRIPADVISOR_REVIEW_QUERY_IDS = ['3d5e9aff1e00e113', 'ef1a9f94012220d3', '51c593cb61092fe5', '9365c2244f5b46a6'];
const TRIPADVISOR_REVIEW_QUERY_CACHE_STORE = 'tripadvisor-reviews-scraper-cache';
const TRIPADVISOR_REVIEW_QUERY_CACHE_KEY = 'CURRENT_REVIEW_QUERY';
const MAX_REVIEWS_PER_PAGE = 20;
const DATASET_PUSH_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REQUEST_ATTEMPTS = 4;
const MAX_SESSION_BOOTSTRAP_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 20000;
const MAX_HTTP_CLIENT_CACHE = 64;
const BROWSER_PROFILES = ['chrome', 'firefox', 'ios18'];
const BLOCKED_STATUS_CODES = new Set([401, 403, 407, 429]);
const REVIEW_SORTS = {
    MOST_RECENT: { sortType: 'DEFAULT', sortBy: 'DATE' },
    HIGHEST_RATED: { sortType: 'DEFAULT', sortBy: 'RATING' },
};

const queryIdState = {
    candidates: [...TRIPADVISOR_REVIEW_QUERY_IDS],
    invalid: new Set(),
};
const httpClientCache = new Map();
let preferredQueryId;
let lastCachedQueryId;
let reviewVariablesTemplate;
let discoveredCookieHeader;
let keyRefreshAttempted = false;
let browserDiscoveryUsed = false;

await Actor.init();

const TRIPADVISOR_GRAPHQL_MARKER = '/data/graphql/ids';
const REVIEW_RESPONSE_MARKER = 'ReviewsProxy_getReviewListPageForLocation';
const BROWSER_DISCOVERY_TIMEOUT_MS = 45000;
const ASSET_BATCH_SIZE = 8;
const REVIEW_TITLE_MARKER = 'data-test-target="review-title"';
const REVIEW_PAGE_SIZE = 10;

function toPatchrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const parsed = new URL(proxyUrl);
        return {
            server: `${parsed.protocol}//${parsed.host}`,
            username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
            password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        };
    } catch {
        return { server: proxyUrl };
    }
}

function extractQueryIdFromBundleText(text) {
    if (typeof text !== 'string' || !text.length) return undefined;
    const markerIndex = text.indexOf(REVIEW_RESPONSE_MARKER);
    if (markerIndex === -1) return undefined;
    const windowText = text.slice(Math.max(0, markerIndex - 8000), markerIndex);
    const matches = [...windowText.matchAll(/id:\s*"([0-9a-f]{16})"/gi)];
    if (!matches.length) return undefined;
    return matches[matches.length - 1][1].toLowerCase();
}

async function collectScriptUrls({ page, client, startUrl }) {
    const urls = new Set();

    if (page) {
        try {
            const fromDom = await page.evaluate(() =>
                [...document.querySelectorAll('script[src]')]
                    .map((script) => script.src)
                    .filter((src) => src.endsWith('.js')),
            );
            for (const url of fromDom) urls.add(url);
        } catch (error) {
            log.debug(`Could not enumerate page scripts: ${error.message}`);
        }
    }

    if (urls.size === 0 && client) {
        try {
            const response = await client.fetch(startUrl, { timeout: REQUEST_TIMEOUT_MS });
            if (response.ok) {
                const html = await response.text();
                for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
                    urls.add(new URL(match[1], startUrl).href);
                }
            }
        } catch (error) {
            log.debug(`Could not fetch the review asset page: ${error.message}`);
        }
    }

    return [...urls];
}

async function fetchBundleText({ client, context, src }) {
    if (client) {
        try {
            const response = await client.fetch(src, { timeout: REQUEST_TIMEOUT_MS });
            if (response.ok) return await response.text();
        } catch (error) {
            log.debug(`impit bundle ${src} failed: ${error.message}`);
        }
    }

    if (context) {
        try {
            const response = await context.request.get(src, { timeout: REQUEST_TIMEOUT_MS });
            if (response.ok()) return await response.text();
        } catch (error) {
            log.debug(`browser bundle ${src} failed: ${error.message}`);
        }
    }

    return undefined;
}

async function discoverQueryIdFromAssets({ client, context, page, startUrl }) {
    const scriptSrcs = await collectScriptUrls({ page, client, startUrl });

    for (let index = 0; index < scriptSrcs.length; index += ASSET_BATCH_SIZE) {
        const batch = scriptSrcs.slice(index, index + ASSET_BATCH_SIZE);
        const texts = await Promise.all(batch.map((src) => fetchBundleText({ client, context, src })));
        for (const text of texts) {
            const queryId = extractQueryIdFromBundleText(text);
            if (queryId) return queryId;
        }
    }

    return undefined;
}

function captureReviewOperationFromNetwork({ page, resolveCapture }) {
    const requestOperations = new Map();

    page.on('request', (request) => {
        if (!request.url().includes(TRIPADVISOR_GRAPHQL_MARKER)) return;
        try {
            requestOperations.set(request, JSON.parse(request.postData() || '[]'));
        } catch (error) {
            log.debug(`Could not parse intercepted GraphQL request: ${error.message}`);
        }
    });

    page.on('response', async (response) => {
        const request = response.request();
        const operations = requestOperations.get(request);
        if (!operations) return;
        try {
            const text = await response.text();
            if (!text.includes(REVIEW_RESPONSE_MARKER)) return;
            const parsed = JSON.parse(text);
            for (let index = 0; index < parsed.length; index += 1) {
                if (!parsed[index]?.data?.[REVIEW_RESPONSE_MARKER]) continue;
                const operation = operations[index];
                const queryId = operation?.extensions?.preRegisteredQueryId;
                if (queryId) resolveCapture({ queryId, variablesTemplate: operation.variables });
                return;
            }
        } catch (error) {
            log.debug(`Could not parse intercepted GraphQL response: ${error.message}`);
        }
    });
}

async function discoverReviewOperation({ startUrl, proxyUrl, client }) {
    let context;
    let timeoutHandle;

    try {
        context = await chromium.launchPersistentContext('', {
            channel: 'chrome',
            headless: false,
            noViewport: true,
            proxy: toPatchrightProxy(proxyUrl),
        });
    } catch (error) {
        log.debug(`Patchright Chrome could not launch: ${error.message}`);
        return {};
    }

    try {
        const page = context.pages()[0] || (await context.newPage());

        let resolveCapture;
        const capturePromise = new Promise((resolve) => {
            resolveCapture = resolve;
        });
        timeoutHandle = setTimeout(() => resolveCapture(undefined), BROWSER_DISCOVERY_TIMEOUT_MS);
        captureReviewOperationFromNetwork({ page, resolveCapture });

        try {
            await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        } catch (error) {
            log.debug(`Discovery navigation issue: ${error.message}`);
        }

        let queryId = await discoverQueryIdFromAssets({ client, context, page, startUrl });
        let variablesTemplate;

        if (!queryId) {
            const capture = await capturePromise;
            queryId = capture?.queryId;
            variablesTemplate = capture?.variablesTemplate;
        }

        const cookies = await context.cookies();
        const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

        if (queryId) log.debug(`Patchright discovered the current review operation: ${queryId}.`);

        return { queryId, variablesTemplate, cookieHeader };
    } catch (error) {
        log.debug(`Patchright discovery failed: ${error.message}`);
        return {};
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        await context.close().catch(() => {});
    }
}

function decodeHtmlEntities(text) {
    if (!text) return undefined;
    const decoded = text
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#x2F;/g, '/')
        .replace(/\u00a0/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return decoded || undefined;
}

function firstHtmlMatch(text, regex) {
    const match = text.match(regex);
    return match ? match[1] : undefined;
}

function toAbsoluteReviewUrl(pathOrUrl) {
    if (!pathOrUrl) return undefined;
    return pathOrUrl.startsWith('http') ? pathOrUrl : `${TRIPADVISOR_ORIGIN}${pathOrUrl}`;
}

function buildReviewPageUrl(startUrl, offset) {
    if (offset <= 0) return startUrl.replace(/-Reviews-or\d+-/i, '-Reviews-');
    if (/-Reviews-or\d+-/i.test(startUrl)) return startUrl.replace(/-Reviews-or\d+-/i, `-Reviews-or${offset}-`);
    return startUrl.replace(/-Reviews-/i, `-Reviews-or${offset}-`);
}

function parseReviewsFromHtml(html, context) {
    if (typeof html !== 'string' || !html.length) return [];

    const positions = [];
    let index = html.indexOf(REVIEW_TITLE_MARKER);
    while (index !== -1) {
        positions.push(index);
        index = html.indexOf(REVIEW_TITLE_MARKER, index + 1);
    }

    const reviews = [];
    for (let i = 0; i < positions.length; i += 1) {
        const start = Math.max(0, positions[i] - 1600);
        const end = i + 1 < positions.length ? positions[i + 1] - 1600 : Math.min(html.length, positions[i] + 20000);
        const block = html.slice(start, end);

        const titleMatch = block.match(/review-title"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        const reviewPath = titleMatch?.[1];
        const reviewId = reviewPath?.match(/-r(\d+)-/)?.[1];
        if (!reviewId) continue;

        const rating = Number(firstHtmlMatch(block, /bubbleRatingImage[^>]*><title[^>]*>([\d.]+) of 5 bubbles/));
        const userName = firstHtmlMatch(block, /href="\/Profile\/([^"]+)"/);
        const contributions = firstHtmlMatch(block, /(\d+)<!-- --> <!-- -->contributions/);
        const hometown = firstHtmlMatch(
            block,
            /Profile\/[^"]+"[\s\S]{0,400}?biGQs _P VImYz AWdfh">([^<]+)<\/span><span class="qVkLn"><span[^>]*>\d+/,
        );

        reviews.push({
            item_type: 'review',
            review_id: reviewId,
            location_id: context.locationId ? String(context.locationId) : undefined,
            rating: Number.isFinite(rating) ? rating : undefined,
            title: decodeHtmlEntities(titleMatch?.[2]),
            review_text: decodeHtmlEntities(
                firstHtmlMatch(block, /<span class="JguWG">[\s\S]*?<span>([\s\S]*?)<\/span>/),
            ),
            published_date: firstHtmlMatch(block, /a review\s*(?:<!-- -->)?\s*([A-Z][a-z]{2} \d{4})/),
            stay_date: firstHtmlMatch(block, /Date of stay:<\/span><\/div><span[^>]*>([^<]+)<\/span>/),
            trip_type: firstHtmlMatch(block, /Trip type:<\/span><\/div><span[^>]*>([^<]+)<\/span>/),
            user_name: userName,
            user_profile_url: userName ? `${TRIPADVISOR_ORIGIN}/Profile/${userName}` : undefined,
            user_contributions: contributions ? Number(contributions) : undefined,
            user_hometown: hometown ? decodeHtmlEntities(hometown) : undefined,
            source_url: context.startUrl,
            review_url: toAbsoluteReviewUrl(reviewPath),
        });
    }

    return reviews;
}

function compactValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
    }
    if (Array.isArray(value)) {
        const compactedArray = value.map(compactValue).filter((item) => item !== undefined);
        return compactedArray.length ? compactedArray : undefined;
    }
    if (typeof value === 'object') {
        const output = {};
        for (const [key, nestedValue] of Object.entries(value)) {
            const compacted = compactValue(nestedValue);
            if (compacted !== undefined) output[key] = compacted;
        }
        return Object.keys(output).length ? output : undefined;
    }
    return value;
}

function compactRecord(record) {
    return compactValue(record) || {};
}

function extractLocationIdFromUrl(url) {
    const match = String(url || '').match(/-d(\d+)-/i);
    return match ? match[1] : undefined;
}

function normalizeTripadvisorUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const url = value.trim();
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function absoluteTripadvisorUrl(pathOrUrl) {
    if (!pathOrUrl) return undefined;
    const value = String(pathOrUrl);
    return value.startsWith('http') ? value : `https://www.tripadvisor.com${value}`;
}

function mapAdditionalRatings(additionalRatings) {
    if (!Array.isArray(additionalRatings) || !additionalRatings.length) return undefined;
    const output = {};
    for (const item of additionalRatings) {
        const key = item?.ratingLabelLocalizedString;
        const value = item?.rating;
        if (!key || !Number.isFinite(Number(value))) continue;
        output[key] = Number(value);
    }
    return Object.keys(output).length ? output : undefined;
}

function normalizeReview(rawReview, context) {
    return compactRecord({
        item_type: 'review',
        review_id: rawReview.id,
        location_id: String(rawReview.location?.locationId || rawReview.locationId || context.locationId),
        location_name: rawReview.location?.name,
        location_type: rawReview.location?.placeType,
        rating: Number.isFinite(Number(rawReview.rating)) ? Number(rawReview.rating) : undefined,
        title: rawReview.title,
        review_text: rawReview.text,
        language: rawReview.language,
        original_language: rawReview.originalLanguage,
        published_date: rawReview.publishedDate,
        created_date: rawReview.createdDate,
        trip_type: rawReview.tripInfo?.tripType,
        stay_date: rawReview.tripInfo?.stayDate,
        helpful_votes: rawReview.helpfulVotes,
        user_id: rawReview.userProfile?.id,
        user_name: rawReview.userProfile?.displayName || rawReview.userProfile?.username,
        user_profile_url: absoluteTripadvisorUrl(rawReview.userProfile?.route?.url),
        user_contributions: rawReview.userProfile?.contributionCounts?.sumAllUgc,
        user_hometown:
            rawReview.userProfile?.hometown?.location?.additionalNames?.long ||
            rawReview.userProfile?.hometown?.fallbackString,
        source_url: context.startUrl,
        review_url: absoluteTripadvisorUrl(rawReview.reviewDetailPageWrapper?.reviewDetailPageRoute?.url),
        management_response_text: rawReview.mgmtResponse?.text,
        management_response_date: rawReview.mgmtResponse?.publishedDate,
        additional_ratings: mapAdditionalRatings(rawReview.additionalRatings),
        total_reviews_on_page: context.totalReviewsOnPage,
    });
}

function getReviewDedupKey(review) {
    return (
        review.review_id ||
        `${review.title || ''}|${review.published_date || ''}|${review.user_name || ''}|${review.rating || ''}`
    );
}

function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function buildReviewFilters({ searchText, lang }) {
    const filters = [];
    if (searchText) filters.push({ axis: 'TEXT', selections: [searchText] });
    if (lang) filters.push({ axis: 'LANGUAGE', selections: [lang] });
    return filters;
}

function toPositiveInteger(value, fallback) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 1) return fallback;
    return Math.floor(numberValue);
}

function randomToken(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let output = '';
    for (let index = 0; index < length; index += 1) {
        output += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return output;
}

function randomSessionId() {
    return `ta_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function pickBrowserProfile(attempt) {
    return BROWSER_PROFILES[(attempt - 1) % BROWSER_PROFILES.length];
}

function getHttpClient(browser, proxyUrl) {
    const cacheKey = `${browser}::${proxyUrl || ''}`;
    let client = httpClientCache.get(cacheKey);
    if (!client) {
        client = new Impit({
            browser,
            timeout: REQUEST_TIMEOUT_MS,
            ...(proxyUrl ? { proxyUrl } : {}),
        });
        if (httpClientCache.size >= MAX_HTTP_CLIENT_CACHE) {
            const oldestKey = httpClientCache.keys().next().value;
            if (oldestKey !== undefined) httpClientCache.delete(oldestKey);
        }
        httpClientCache.set(cacheKey, client);
    }
    return client;
}

async function resolveProxyUrl(proxyConfiguration) {
    if (!proxyConfiguration) return undefined;
    try {
        return await proxyConfiguration.newUrl(randomSessionId());
    } catch (error) {
        log.warning(`Could not create a proxy URL: ${error.message}`);
        return undefined;
    }
}

function getSetCookieHeaders(response) {
    try {
        if (response?.headers && typeof response.headers.getSetCookie === 'function') {
            return response.headers.getSetCookie();
        }
    } catch (error) {
        log.debug(`Could not read set-cookie headers: ${error.message}`);
    }
    return [];
}

function mergeResponseCookies(cookieMap, response) {
    for (const rawCookie of getSetCookieHeaders(response)) {
        const pair = String(rawCookie).split(';')[0]?.trim();
        if (!pair) continue;
        const separatorIndex = pair.indexOf('=');
        if (separatorIndex <= 0) continue;
        const name = pair.slice(0, separatorIndex).trim();
        const value = pair.slice(separatorIndex + 1).trim();
        if (name) cookieMap.set(name.toLowerCase(), { name, value });
    }
}

function getCookieValue(cookieMap, name) {
    const entry = cookieMap?.get(name.toLowerCase());
    return entry ? entry.value : undefined;
}

function setCookieValue(cookieMap, name, value) {
    cookieMap.set(name.toLowerCase(), { name, value });
}

function serializeCookies(cookieMap) {
    if (!cookieMap || !cookieMap.size) return '';
    return [...cookieMap.values()].map((entry) => `${entry.name}=${entry.value}`).join('; ');
}

function seedCookiesFromHeader(cookieMap, cookieHeader) {
    if (!cookieMap || typeof cookieHeader !== 'string' || !cookieHeader) return;
    for (const pair of cookieHeader.split(';')) {
        const trimmed = pair.trim();
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex <= 0) continue;
        const name = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim();
        if (name) cookieMap.set(name.toLowerCase(), { name, value });
    }
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isBlockedResponse(status, body) {
    if (BLOCKED_STATUS_CODES.has(status)) return true;
    if (typeof body !== 'string' || !body) return false;
    const lowered = body.toLowerCase();
    return (
        lowered.includes('datadome') ||
        lowered.includes('captcha') ||
        lowered.includes('px-captcha') ||
        lowered.includes('just a moment') ||
        lowered.includes('access denied')
    );
}

function isPersistedQueryError(message) {
    return /persisted\s*query/i.test(String(message || ''));
}

function parseRetryAfterMillis(response) {
    try {
        const header = response?.headers?.get?.('retry-after');
        if (!header) return undefined;
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
        const dateMillis = Date.parse(header);
        if (Number.isFinite(dateMillis)) return Math.min(Math.max(dateMillis - Date.now(), 0), MAX_BACKOFF_MS);
    } catch (error) {
        log.debug(`Could not parse retry-after header: ${error.message}`);
    }
    return undefined;
}

function backoffDelayMs(attempt, response) {
    const retryAfter = parseRetryAfterMillis(response);
    if (retryAfter !== undefined) return retryAfter;
    const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return base + Math.floor(Math.random() * 500);
}

function discoverQueryIds(html) {
    if (typeof html !== 'string' || !html.length) return [];
    const found = new Set();
    const patterns = [
        /preRegisteredQueryId["']?\s*[:=]\s*["']([0-9a-f]{16})["']/gi,
        /["']([0-9a-f]{16})["']\s*,?\s*(?:extensions|preRegisteredQueryId)/gi,
    ];
    for (const pattern of patterns) {
        for (const match of html.matchAll(pattern)) {
            found.add(match[1].toLowerCase());
        }
    }
    return [...found];
}

function addQueryIdCandidates(ids) {
    const additions = ids
        .filter((id) => typeof id === 'string' && /^[0-9a-f]{16}$/i.test(id))
        .map((id) => id.toLowerCase())
        .filter((id) => !queryIdState.candidates.includes(id));
    if (additions.length) {
        queryIdState.candidates = [...additions, ...queryIdState.candidates];
        for (const id of additions) queryIdState.invalid.delete(id);
    }
}

function pickQueryId(attempt) {
    if (preferredQueryId && !queryIdState.invalid.has(preferredQueryId)) return preferredQueryId;
    const valid = queryIdState.candidates.filter((id) => !queryIdState.invalid.has(id));
    if (valid.length) return valid[(attempt - 1) % valid.length];
    queryIdState.invalid.clear();
    return queryIdState.candidates[(attempt - 1) % queryIdState.candidates.length];
}

function markQueryIdInvalid(queryId) {
    queryIdState.invalid.add(queryId);
    if (preferredQueryId === queryId) preferredQueryId = undefined;
}

async function loadCachedReviewQueryId() {
    if (CONFIGURED_REVIEW_QUERY_ID) return undefined;
    try {
        const store = await Actor.openKeyValueStore(TRIPADVISOR_REVIEW_QUERY_CACHE_STORE);
        const cached = await store.getValue(TRIPADVISOR_REVIEW_QUERY_CACHE_KEY);
        const queryId = typeof cached === 'object' ? cached?.queryId : cached;
        if (typeof queryId === 'string' && /^[0-9a-f]{16}$/i.test(queryId)) {
            return queryId.toLowerCase();
        }
    } catch (error) {
        log.debug(`Review operation cache unavailable: ${error.message}`);
    }
    return undefined;
}

async function cacheReviewQueryId(queryId) {
    if (CONFIGURED_REVIEW_QUERY_ID || typeof queryId !== 'string' || !/^[0-9a-f]{16}$/i.test(queryId)) {
        return;
    }
    const normalized = queryId.toLowerCase();
    if (normalized === lastCachedQueryId) return;
    lastCachedQueryId = normalized;
    try {
        const store = await Actor.openKeyValueStore(TRIPADVISOR_REVIEW_QUERY_CACHE_STORE);
        await store.setValue(TRIPADVISOR_REVIEW_QUERY_CACHE_KEY, {
            queryId: normalized,
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        log.debug(`Could not cache the review operation: ${error.message}`);
    }
}

async function refreshReviewQueryId({ startUrl, proxyConfiguration }) {
    if (keyRefreshAttempted) return undefined;
    keyRefreshAttempted = true;
    const discoveryProxyUrl = await resolveProxyUrl(proxyConfiguration);
    const discoveryClient = getHttpClient('chrome', discoveryProxyUrl);
    const result = await discoverReviewOperation({
        startUrl,
        proxyUrl: discoveryProxyUrl,
        client: discoveryClient,
    });
    if (result.cookieHeader) discoveredCookieHeader = result.cookieHeader;
    if (result.variablesTemplate) reviewVariablesTemplate = result.variablesTemplate;
    if (result.queryId) {
        addQueryIdCandidates([result.queryId]);
        preferredQueryId = result.queryId;
        queryIdState.invalid.delete(result.queryId);
        browserDiscoveryUsed = true;
        await cacheReviewQueryId(result.queryId);
        log.info('Review access refreshed automatically.');
    }
    return result.queryId;
}

async function createTripadvisorSession({ startUrl, proxyConfiguration, browser }) {
    const generatedToken = randomToken(180);
    let lastStatus;
    let lastCookieMap = new Map();
    let lastProxyUrl;

    for (let attempt = 1; attempt <= MAX_SESSION_BOOTSTRAP_ATTEMPTS; attempt += 1) {
        const sessionBrowser = attempt === 1 ? browser : pickBrowserProfile(attempt);
        const proxyUrl = await resolveProxyUrl(proxyConfiguration);
        const client = getHttpClient(sessionBrowser, proxyUrl);
        const cookieMap = new Map();
        seedCookiesFromHeader(cookieMap, discoveredCookieHeader);
        lastCookieMap = cookieMap;
        lastProxyUrl = proxyUrl;

        try {
            const response = await client.fetch(startUrl, {
                method: 'GET',
                headers: {
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'en-US,en;q=0.9',
                    'upgrade-insecure-requests': '1',
                },
                timeout: REQUEST_TIMEOUT_MS,
                redirect: 'follow',
            });
            lastStatus = response.status;
            mergeResponseCookies(cookieMap, response);
            const body = await response.text();

            if (!isBlockedResponse(response.status, body)) {
                const discovered = discoverQueryIds(body);
                if (discovered.length) addQueryIdCandidates(discovered);
                const token = getCookieValue(cookieMap, 'taunique') || generatedToken;
                setCookieValue(cookieMap, 'TAUnique', token);
                return { statusCode: response.status, token, cookieMap, proxyUrl, browser: sessionBrowser };
            }
            log.debug(
                `Session bootstrap returned HTTP ${response.status} on attempt ${attempt}/${MAX_SESSION_BOOTSTRAP_ATTEMPTS}; retrying.`,
            );
        } catch (error) {
            log.debug(
                `Session bootstrap failed on attempt ${attempt}/${MAX_SESSION_BOOTSTRAP_ATTEMPTS}: ${error.message}`,
            );
        }

        if (attempt < MAX_SESSION_BOOTSTRAP_ATTEMPTS) await sleep(backoffDelayMs(attempt));
    }

    const token = getCookieValue(lastCookieMap, 'taunique') || generatedToken;
    setCookieValue(lastCookieMap, 'TAUnique', token);
    return { statusCode: lastStatus, token, cookieMap: lastCookieMap, proxyUrl: lastProxyUrl, browser };
}

function buildGraphqlHeaders({ token, referer, cookieHeader }) {
    return {
        'content-type': 'application/json;charset=utf-8',
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        origin: TRIPADVISOR_ORIGIN,
        referer,
        'x-requested-by': token,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
    };
}

function buildReviewPayload({ locationId, limit, offset, filters, sort, queryId, variablesTemplate }) {
    return [
        {
            variables: {
                ...(variablesTemplate || {}),
                locationId: Number(locationId),
                locale: variablesTemplate?.locale || TRIPADVISOR_LOCALE,
                limit,
                offset,
                filters,
                sortType: sort.sortType,
                sortBy: sort.sortBy,
                doMachineTranslation: true,
                photosPerReviewLimit: 3,
            },
            extensions: {
                preRegisteredQueryId: queryId,
            },
        },
    ];
}

async function fetchReviewsPage({
    locationId,
    startUrl,
    offset,
    limit,
    filters,
    sort,
    session,
    getSession,
    refreshQueryId,
}) {
    let lastError;
    let activeSession = session;
    let activeQueryId = pickQueryId(1);

    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
        if (attempt > 1) {
            activeSession = await getSession(attempt);
        }

        const queryId = activeQueryId;
        const browser = activeSession?.browser || pickBrowserProfile(attempt);
        const proxyUrl = activeSession?.proxyUrl;
        const client = getHttpClient(browser, proxyUrl);

        try {
            const response = await client.fetch(TRIPADVISOR_GRAPHQL_ENDPOINT, {
                method: 'POST',
                headers: buildGraphqlHeaders({
                    token: activeSession?.token || randomToken(180),
                    referer: startUrl,
                    cookieHeader: serializeCookies(activeSession?.cookieMap),
                }),
                body: JSON.stringify(
                    buildReviewPayload({
                        locationId,
                        limit,
                        offset,
                        filters,
                        sort,
                        queryId,
                        variablesTemplate: reviewVariablesTemplate,
                    }),
                ),
                timeout: REQUEST_TIMEOUT_MS,
            });
            const bodyText = await response.text();

            if (BLOCKED_STATUS_CODES.has(response.status) || response.status >= 500) {
                lastError = new Error(
                    `TripAdvisor reviews request was blocked or failed with HTTP ${response.status}.`,
                );
                log.debug(`${lastError.message} Refreshing session and retrying.`);
                await sleep(backoffDelayMs(attempt, response));
                continue;
            }
            if (response.status >= 400) {
                lastError = new Error(`TripAdvisor reviews request failed with HTTP ${response.status}.`);
                await sleep(backoffDelayMs(attempt, response));
                continue;
            }

            const parsed = safeJsonParse(bodyText);
            if (!parsed) {
                lastError = new Error('TripAdvisor reviews API returned a non-JSON response.');
                await sleep(backoffDelayMs(attempt));
                continue;
            }

            const graphqlError = parsed?.[0]?.errors?.[0]?.message;
            if (graphqlError && isPersistedQueryError(graphqlError)) {
                markQueryIdInvalid(queryId);
                lastError = new Error(`TripAdvisor reviews API rejected the operation.`);
                log.debug(`${lastError.message} Refreshing access automatically.`);
                if (refreshQueryId) await refreshQueryId();
                activeQueryId = pickQueryId(attempt + 1);
                await sleep(backoffDelayMs(attempt));
                continue;
            }
            if (graphqlError) {
                throw new Error(`TripAdvisor reviews API returned an error: ${graphqlError}`);
            }

            const pageData = parsed?.[0]?.data?.ReviewsProxy_getReviewListPageForLocation?.[0];
            if (pageData === undefined) {
                markQueryIdInvalid(queryId);
                lastError = new Error('TripAdvisor reviews API returned an unexpected payload.');
                log.debug(`${lastError.message} Refreshing access automatically.`);
                if (refreshQueryId) await refreshQueryId();
                activeQueryId = pickQueryId(attempt + 1);
                await sleep(backoffDelayMs(attempt));
                continue;
            }

            const reviews = Array.isArray(pageData.reviews) ? pageData.reviews : [];
            const totalCount = Number.isFinite(Number(pageData.totalCount)) ? Number(pageData.totalCount) : undefined;
            await cacheReviewQueryId(queryId);
            return { totalCount, reviews, queryId };
        } catch (error) {
            lastError = error;
            log.debug(`Reviews request failed on attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}: ${error.message}`);
            await sleep(backoffDelayMs(attempt));
        }
    }

    throw lastError || new Error('TripAdvisor reviews request failed after multiple attempts.');
}

function pickStartUrls(runtimeInput) {
    const candidates = [runtimeInput?.startUrls, runtimeInput?.startUrl];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const urls = candidate.map(normalizeTripadvisorUrl).filter(Boolean);
            if (urls.length) return urls;
        }
        const url = normalizeTripadvisorUrl(candidate);
        if (url) return [url];
    }

    return [];
}

async function buildProxyConfiguration(proxyConfigInput) {
    if (!proxyConfigInput) return undefined;

    const hasApifyProxyCredentials = Boolean(
        proxyConfigInput.password || process.env.APIFY_PROXY_PASSWORD || process.env.APIFY_TOKEN,
    );

    if (proxyConfigInput.useApifyProxy && !hasApifyProxyCredentials) {
        log.debug('Apify proxy credentials are not available locally. Continuing without proxy.');
        return undefined;
    }

    try {
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput);
        if (!proxyConfiguration) {
            log.debug('Proxy configuration is unavailable. Continuing without proxy.');
            return undefined;
        }
        return proxyConfiguration;
    } catch (error) {
        log.debug(`Proxy configuration failed: ${error.message}`);
        return undefined;
    }
}

async function loadSavedReviewQueryId() {
    if (CONFIGURED_REVIEW_QUERY_ID && /^[0-9a-f]{16}$/i.test(CONFIGURED_REVIEW_QUERY_ID)) {
        addQueryIdCandidates([CONFIGURED_REVIEW_QUERY_ID.toLowerCase()]);
        preferredQueryId = CONFIGURED_REVIEW_QUERY_ID.toLowerCase();
        return preferredQueryId;
    }

    const cachedQueryId = await loadCachedReviewQueryId();
    if (cachedQueryId) {
        addQueryIdCandidates([cachedQueryId]);
        preferredQueryId = cachedQueryId;
    }
    return cachedQueryId;
}

async function runActor() {
    const runtimeInput = (await Actor.getInput()) || {};

    const startUrls = pickStartUrls(runtimeInput);
    if (!startUrls.length) {
        throw new Error('No valid TripAdvisor hotel URLs were provided in startUrls.');
    }
    if (!startUrls.some((url) => extractLocationIdFromUrl(url))) {
        throw new Error(
            'No valid TripAdvisor hotel URLs were provided. Each URL must be a hotel review page containing a -d<locationId>- segment.',
        );
    }

    await loadSavedReviewQueryId();

    const resultsWanted = toPositiveInteger(runtimeInput.results_wanted, 20);
    const maxPages = toPositiveInteger(runtimeInput.max_pages, 5);
    const proxyConfigInput = runtimeInput.proxyConfiguration;
    const searchText = normalizeOptionalString(runtimeInput.searchText ?? runtimeInput.keyword);
    const lang = normalizeOptionalString(runtimeInput.lang).toLowerCase();
    const requestedSortKey = runtimeInput.sortBy ?? 'MOST_RECENT';
    const sortKey =
        typeof requestedSortKey === 'string' && Object.hasOwn(REVIEW_SORTS, requestedSortKey)
            ? requestedSortKey
            : 'MOST_RECENT';
    const sort = REVIEW_SORTS[sortKey];
    const filters = buildReviewFilters({ searchText, lang });

    const proxyConfiguration = await buildProxyConfiguration(proxyConfigInput);

    const seenReviewKeys = new Set();
    let pendingReviews = [];
    let savedReviews = 0;
    let pagesFetched = 0;
    const locationSummaries = [];

    log.info(`Collecting up to ${resultsWanted} reviews from ${startUrls.length} location(s).`);

    for (const startUrl of startUrls) {
        if (savedReviews + pendingReviews.length >= resultsWanted) break;

        const locationId = extractLocationIdFromUrl(startUrl);
        if (!locationId) {
            log.debug(`Skipping URL without a TripAdvisor location ID: ${startUrl}`);
            continue;
        }

        let currentSession = await createTripadvisorSession({
            startUrl,
            proxyConfiguration,
            browser: BROWSER_PROFILES[0],
        });
        const getSession = async (attempt) => {
            currentSession = await createTripadvisorSession({
                startUrl,
                proxyConfiguration,
                browser: pickBrowserProfile(attempt),
            });
            return currentSession;
        };

        let page = 0;
        let offset = 0;
        let totalReviewsOnPage;
        let reviewsForLocation = 0;
        let locationStatus = 'completed';
        let stalledPages = 0;

        while (savedReviews + pendingReviews.length < resultsWanted && page < maxPages) {
            const collectedBefore = savedReviews + pendingReviews.length;
            const limit = Math.min(MAX_REVIEWS_PER_PAGE, resultsWanted - collectedBefore);

            let batch;
            try {
                batch = await fetchReviewsPage({
                    locationId,
                    startUrl,
                    offset,
                    limit,
                    filters,
                    sort,
                    session: currentSession,
                    getSession,
                    refreshQueryId: () => refreshReviewQueryId({ startUrl, proxyConfiguration }),
                });
            } catch (error) {
                locationStatus = 'failed';
                log.debug(`Could not fetch reviews for locationId=${locationId}: ${error.message}`);
                break;
            }

            if (totalReviewsOnPage === undefined) totalReviewsOnPage = batch.totalCount;

            if (!batch.reviews.length) break;

            for (const rawReview of batch.reviews) {
                const normalized = normalizeReview(rawReview, { locationId, startUrl, totalReviewsOnPage });
                if (!Object.keys(normalized).length) continue;

                const key = getReviewDedupKey(normalized);
                if (!key || seenReviewKeys.has(key)) continue;

                seenReviewKeys.add(key);
                pendingReviews.push(normalized);
                reviewsForLocation += 1;

                if (pendingReviews.length >= DATASET_PUSH_BATCH_SIZE) {
                    await Actor.pushData(pendingReviews);
                    savedReviews += pendingReviews.length;
                    pendingReviews = [];
                }

                if (savedReviews + pendingReviews.length >= resultsWanted) break;
            }

            if (pendingReviews.length) {
                await Actor.pushData(pendingReviews);
                savedReviews += pendingReviews.length;
                pendingReviews = [];
            }

            offset += batch.reviews.length;
            page += 1;
            pagesFetched += 1;
            const collectedNow = savedReviews + pendingReviews.length;

            if (collectedNow > collectedBefore) {
                stalledPages = 0;
                log.info(`Collected ${collectedNow}/${resultsWanted} reviews.`);
            } else {
                stalledPages += 1;
            }

            if (batch.reviews.length < limit) break;
            if (collectedNow >= resultsWanted) break;
            if (stalledPages >= 2) break;
        }

        if (savedReviews + pendingReviews.length < resultsWanted && locationStatus !== 'failed') {
            let htmlOffset = 0;
            let htmlPages = 0;
            let consecutiveNoNew = 0;
            let consecutiveFetchFailures = 0;
            let emptyPageRetried = false;

            while (savedReviews + pendingReviews.length < resultsWanted && htmlPages < maxPages) {
                const reviewPageUrl = buildReviewPageUrl(startUrl, htmlOffset);
                let html;

                for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
                    const client = getHttpClient(currentSession.browser, currentSession.proxyUrl);
                    try {
                        const response = await client.fetch(reviewPageUrl, {
                            headers: {
                                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            },
                            timeout: REQUEST_TIMEOUT_MS,
                            redirect: 'follow',
                        });
                        const body = await response.text();
                        if (response.ok && !isBlockedResponse(response.status, body)) {
                            html = body;
                            break;
                        }
                        log.debug(
                            `Review page offset ${htmlOffset} returned HTTP ${response.status}; refreshing session.`,
                        );
                    } catch (error) {
                        log.debug(`Review page offset ${htmlOffset} failed: ${error.message}; refreshing session.`);
                    }
                    currentSession = await getSession(attempt + 1);
                }

                if (!html) {
                    consecutiveFetchFailures += 1;
                    htmlPages += 1;
                    page += 1;
                    pagesFetched += 1;
                    if (consecutiveFetchFailures >= 2) break;
                    htmlOffset += REVIEW_PAGE_SIZE;
                    continue;
                }
                consecutiveFetchFailures = 0;

                const parsedReviews = parseReviewsFromHtml(html, { locationId, startUrl });

                if (parsedReviews.length === 0) {
                    if (emptyPageRetried) break;
                    emptyPageRetried = true;
                    currentSession = await getSession(1);
                    continue;
                }
                emptyPageRetried = false;

                let added = 0;
                for (const record of parsedReviews) {
                    const key = getReviewDedupKey(record);
                    if (!key || seenReviewKeys.has(key)) continue;
                    seenReviewKeys.add(key);
                    pendingReviews.push(record);
                    reviewsForLocation += 1;
                    added += 1;

                    if (pendingReviews.length >= DATASET_PUSH_BATCH_SIZE) {
                        await Actor.pushData(pendingReviews);
                        savedReviews += pendingReviews.length;
                        pendingReviews = [];
                    }

                    if (savedReviews + pendingReviews.length >= resultsWanted) break;
                }

                if (pendingReviews.length) {
                    await Actor.pushData(pendingReviews);
                    savedReviews += pendingReviews.length;
                    pendingReviews = [];
                }

                htmlPages += 1;
                page += 1;
                pagesFetched += 1;

                if (added > 0) {
                    consecutiveNoNew = 0;
                    log.info(`Collected ${savedReviews + pendingReviews.length}/${resultsWanted} reviews.`);
                } else {
                    consecutiveNoNew += 1;
                }

                if (savedReviews + pendingReviews.length >= resultsWanted) break;
                if (consecutiveNoNew >= 3) break;
                htmlOffset += parsedReviews.length || REVIEW_PAGE_SIZE;
            }
        }

        locationSummaries.push({
            start_url: startUrl,
            location_id: locationId,
            reviews_on_page: totalReviewsOnPage,
            pages_fetched: page,
            last_offset: offset,
            reviews_collected: reviewsForLocation,
            status: locationStatus,
        });
    }

    if (pendingReviews.length) {
        await Actor.pushData(pendingReviews);
        savedReviews += pendingReviews.length;
    }

    if (!savedReviews) {
        throw new Error(
            'No reviews returned from TripAdvisor. The session was likely blocked (DataDome). ' +
                'Enable an Apify RESIDENTIAL proxy group and re-run. See API_DISCOVERY.md for the request flow, ' +
                'and check the logged query id candidates and bootstrap HTTP status.',
        );
    }

    await Actor.setValue('RUN_INFO', {
        start_urls: startUrls,
        locations: locationSummaries,
        requested_reviews: resultsWanted,
        saved_reviews: savedReviews,
        pages_fetched: pagesFetched,
        sort_by: sortKey,
        filters,
        review_query_id: preferredQueryId || queryIdState.candidates[0],
        query_id_candidates: queryIdState.candidates,
        browser_discovery_used: browserDiscoveryUsed,
    });
    log.info(`Saved ${savedReviews} unique user reviews across ${locationSummaries.length} location(s).`);
}

let failed = false;
try {
    await runActor();
} catch (error) {
    failed = true;
    log.error(`Actor failed: ${error.message}`);
} finally {
    await Actor.exit({ exitCode: failed ? 1 : 0 });
}
