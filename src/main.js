import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const TRIPADVISOR_GRAPHQL_ENDPOINT = 'https://www.tripadvisor.com/data/graphql/ids';
const TRIPADVISOR_REVIEWS_QUERY_ID = 'ef1a9f94012220d3';
const MAX_REVIEWS_PER_PAGE = 20;
const DATASET_PUSH_BATCH_SIZE = 100;
const REVIEW_SORTS = {
    MOST_RECENT: { sortType: 'DEFAULT', sortBy: 'DATE' },
    HIGHEST_RATED: { sortType: 'DEFAULT', sortBy: 'RATING' },
};

await Actor.init();

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
        user_hometown: rawReview.userProfile?.hometown?.location?.additionalNames?.long || rawReview.userProfile?.hometown?.fallbackString,
        source_url: context.startUrl,
        review_url: absoluteTripadvisorUrl(rawReview.reviewDetailPageWrapper?.reviewDetailPageRoute?.url),
        management_response_text: rawReview.mgmtResponse?.text,
        management_response_date: rawReview.mgmtResponse?.publishedDate,
        additional_ratings: mapAdditionalRatings(rawReview.additionalRatings),
        total_reviews_on_page: context.totalReviewsOnPage,
    });
}

function getReviewDedupKey(review) {
    return review.review_id
        || `${review.title || ''}|${review.published_date || ''}|${review.user_name || ''}|${review.rating || ''}`;
}

function toCookieHeader(setCookieHeader) {
    if (!Array.isArray(setCookieHeader)) return undefined;
    const cookies = setCookieHeader
        .map((cookie) => String(cookie).split(';')[0]?.trim())
        .filter(Boolean);
    return cookies.length ? cookies.join('; ') : undefined;
}

async function initializeGraphqlSession({ startUrl, proxyUrl }) {
    const response = await gotScraping({
        url: startUrl,
        headers: {
            'user-agent': DEFAULT_USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        proxyUrl,
        timeout: { request: 30000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
    });

    return {
        statusCode: response.statusCode,
        cookieHeader: toCookieHeader(response.headers['set-cookie']),
    };
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

async function fetchReviewsPage({ locationId, startUrl, offset, limit, proxyUrl, cookieHeader, filters, sort }) {
    const payload = [
        {
            variables: {
                locationId: Number(locationId),
                limit,
                offset,
                filters,
                sortType: sort.sortType,
                sortBy: sort.sortBy,
                doMachineTranslation: true,
                photosPerReviewLimit: 3,
            },
            extensions: {
                preRegisteredQueryId: TRIPADVISOR_REVIEWS_QUERY_ID,
            },
        },
    ];

    const response = await gotScraping({
        url: TRIPADVISOR_GRAPHQL_ENDPOINT,
        method: 'POST',
        headers: {
            'user-agent': DEFAULT_USER_AGENT,
            accept: '*/*',
            'content-type': 'application/json',
            origin: 'https://www.tripadvisor.com',
            referer: startUrl,
            'x-requested-by': 'tripadvisor.com',
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(payload),
        proxyUrl,
        timeout: { request: 30000 },
        retry: { limit: 0 },
        throwHttpErrors: false,
    });

    if (response.statusCode >= 400) {
        throw new Error(`TripAdvisor reviews API failed with HTTP ${response.statusCode}.`);
    }

    let parsedResponse;
    try {
        parsedResponse = JSON.parse(response.body);
    } catch (error) {
        throw new Error(`Failed to parse reviews API response JSON: ${error.message}`);
    }

    const graphqlError = parsedResponse?.[0]?.errors?.[0]?.message;
    if (graphqlError) {
        throw new Error(`TripAdvisor reviews API returned an error: ${graphqlError}`);
    }

    const pageData = parsedResponse?.[0]?.data?.ReviewsProxy_getReviewListPageForLocation?.[0];
    return {
        totalCount: Number.isFinite(Number(pageData?.totalCount)) ? Number(pageData.totalCount) : undefined,
        reviews: Array.isArray(pageData?.reviews) ? pageData.reviews : [],
    };
}

function toPositiveInteger(value, fallback) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 1) return fallback;
    return Math.floor(numberValue);
}

async function readJsonFileIfExists(filePath) {
    try {
        const raw = await readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error?.code === 'ENOENT') return {};
        log.warning(`Could not read ${filePath}: ${error.message}`);
        return {};
    }
}

function pickStartUrls(runtimeInput, fallbackInput) {
    const candidates = [runtimeInput?.startUrls, fallbackInput?.startUrls];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
            const urls = candidate.map(normalizeTripadvisorUrl).filter(Boolean);
            if (urls.length) return urls;
        }
    }

    // Keep old API callers working while the public input is migrated to startUrls.
    const legacyCandidates = [runtimeInput?.startUrl, fallbackInput?.startUrl];
    for (const candidate of legacyCandidates) {
        const url = normalizeTripadvisorUrl(candidate);
        if (url) return [url];
    }

    return [];
}

async function runActor() {
    const runtimeInput = (await Actor.getInput()) || {};
    const fallbackInput = await readJsonFileIfExists('INPUT.json');
    const hasRuntimeInput = Object.keys(runtimeInput).length > 0;
    if (!hasRuntimeInput && Object.keys(fallbackInput).length > 0) {
        log.info('Runtime input is empty. Using INPUT.json fallback values.');
    }

    const startUrls = pickStartUrls(runtimeInput, fallbackInput);
    if (!startUrls.length) {
        throw new Error('No valid TripAdvisor hotel URLs were provided in startUrls.');
    }

    const resultsWanted = toPositiveInteger(runtimeInput.results_wanted ?? fallbackInput.results_wanted, 20);
    const maxPages = toPositiveInteger(runtimeInput.max_pages ?? fallbackInput.max_pages, 5);
    const proxyConfigInput = runtimeInput.proxyConfiguration ?? fallbackInput.proxyConfiguration;
    const searchText = normalizeOptionalString(
        runtimeInput.searchText
        ?? runtimeInput.keyword
        ?? fallbackInput.searchText
        ?? fallbackInput.keyword,
    );
    const lang = normalizeOptionalString(runtimeInput.lang ?? fallbackInput.lang).toLowerCase();
    const requestedSortKey = runtimeInput.sortBy ?? fallbackInput.sortBy ?? 'MOST_RECENT';
    const sortKey = typeof requestedSortKey === 'string' && Object.hasOwn(REVIEW_SORTS, requestedSortKey)
        ? requestedSortKey
        : 'MOST_RECENT';
    const sort = REVIEW_SORTS[sortKey];
    const filters = buildReviewFilters({ searchText, lang });

    let proxyUrl;
    if (proxyConfigInput) {
        const hasApifyProxyCredentials = Boolean(
            proxyConfigInput.password
            || process.env.APIFY_PROXY_PASSWORD
            || process.env.APIFY_TOKEN,
        );

        if (proxyConfigInput.useApifyProxy && !hasApifyProxyCredentials) {
            log.info('Apify proxy credentials are not available locally. Continuing without proxy.');
        } else {
            try {
                const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput);
                if (proxyConfiguration) {
                    proxyUrl = await proxyConfiguration.newUrl();
                } else {
                    log.warning('Proxy configuration is unavailable. Continuing without proxy.');
                }
            } catch (error) {
                log.warning(`Proxy configuration failed: ${error.message}`);
            }
        }
    }

    const seenReviewKeys = new Set();
    let pendingReviews = [];
    let savedReviews = 0;
    let pagesFetched = 0;
    const locationSummaries = [];

    log.info(`Sort=${sortKey}, API sortType=${sort.sortType}, API sortBy=${sort.sortBy}, filters=${filters.length}.`);

    for (const startUrl of startUrls) {
        if ((savedReviews + pendingReviews.length) >= resultsWanted) break;

        const locationId = extractLocationIdFromUrl(startUrl);
        if (!locationId) {
            log.warning(`Skipping URL without a TripAdvisor location ID: ${startUrl}`);
            continue;
        }

        const session = await initializeGraphqlSession({ startUrl, proxyUrl });
        log.info(`TripAdvisor session bootstrap status for locationId=${locationId}: HTTP ${session.statusCode}.`);
        if (!session.cookieHeader) {
            log.warning(`TripAdvisor bootstrap returned no session cookies for locationId=${locationId}.`);
        }

        let page = 0;
        let offset = 0;
        let totalReviewsOnPage;

        while ((savedReviews + pendingReviews.length) < resultsWanted && page < maxPages) {
            const collectedReviews = savedReviews + pendingReviews.length;
            const limit = Math.min(MAX_REVIEWS_PER_PAGE, resultsWanted - collectedReviews);
            const batch = await fetchReviewsPage({
                locationId,
                startUrl,
                offset,
                limit,
                proxyUrl,
                cookieHeader: session.cookieHeader,
                filters,
                sort,
            });
            if (totalReviewsOnPage === undefined) totalReviewsOnPage = batch.totalCount;

            if (!batch.reviews.length) break;

            for (const rawReview of batch.reviews) {
                const normalized = normalizeReview(rawReview, { locationId, startUrl, totalReviewsOnPage });
                if (!Object.keys(normalized).length) continue;

                const key = getReviewDedupKey(normalized);
                if (!key || seenReviewKeys.has(key)) continue;

                seenReviewKeys.add(key);
                pendingReviews.push(normalized);

                if (pendingReviews.length >= DATASET_PUSH_BATCH_SIZE) {
                    await Actor.pushData(pendingReviews);
                    savedReviews += pendingReviews.length;
                    pendingReviews = [];
                }

                if ((savedReviews + pendingReviews.length) >= resultsWanted) break;
            }

            offset += batch.reviews.length;
            page += 1;
            pagesFetched += 1;
            log.info(`Progress: locationId=${locationId}, page=${page}, offset=${offset}, collected=${savedReviews + pendingReviews.length}/${resultsWanted}, reviews_on_page=${totalReviewsOnPage || 'n/a'}.`);

            if (batch.reviews.length < limit) break;
        }

        locationSummaries.push({
            start_url: startUrl,
            location_id: locationId,
            reviews_on_page: totalReviewsOnPage,
            pages_fetched: page,
            last_offset: offset,
        });
    }

    if (pendingReviews.length) {
        await Actor.pushData(pendingReviews);
        savedReviews += pendingReviews.length;
    }

    if (!savedReviews) {
        throw new Error('No reviews returned from TripAdvisor reviews API.');
    }

    await Actor.setValue('RUN_INFO', {
        start_urls: startUrls,
        locations: locationSummaries,
        requested_reviews: resultsWanted,
        saved_reviews: savedReviews,
        pages_fetched: pagesFetched,
        sort_by: sortKey,
        filters,
    });
    log.info(`Saved ${savedReviews} unique user reviews across ${locationSummaries.length} location(s).`);
}

try {
    await runActor();
} catch (error) {
    log.error(`Actor failed: ${error.message}`);
    throw error;
} finally {
    await Actor.exit();
}
