# TripAdvisor Reviews API Discovery

## Selected API

- Endpoint: `https://www.tripadvisor.com/data/graphql/ids`
- Method: `POST`
- Fetch client: `impit` (browser-impersonating HTTP client)
- Query discovery: `patchright` (Chrome) discovers the current persisted query ID when it goes stale
- Authentication: no API key. The endpoint requires a `TAUnique` client token plus a browser session.
- Review query ID: persisted GraphQL query, rotated by TripAdvisor over time (current: `3d5e9aff1e00e113`).
- Pagination: `offset` + `limit`
- Location ID: extracted from the hotel URL segment `-d<locationId>-`

The actor accepts `startUrls` as a required string array and processes each hotel URL until the global `results_wanted` limit is reached.

## Verified request shape

The request is a JSON array containing one persisted GraphQL query:

```json
[
    {
        "variables": {
            "locationId": 14930175,
            "locale": "en-US",
            "limit": 20,
            "offset": 0,
            "filters": [
                { "axis": "TEXT", "selections": ["breakfast"] },
                { "axis": "LANGUAGE", "selections": ["en"] }
            ],
            "sortType": "DEFAULT",
            "sortBy": "DATE",
            "doMachineTranslation": true,
            "photosPerReviewLimit": 3
        },
        "extensions": {
            "preRegisteredQueryId": "3d5e9aff1e00e113"
        }
    }
]
```

The `filters` value is an array of `{ axis, selections }` objects. Empty filters are sent as `[]`; the actor does not invent unsupported GraphQL filter axes. The current review operation requires a `locale` variable (`String!`); omit it and the API returns `Variable "$locale" of required type "String!" was not provided`.

## Required request headers

The actor bootstraps the hotel page first and then replays the GraphQL request with the captured session. The endpoint rejects requests that do not present the client token and same-origin context.

| Header            | Value                                       | Notes                                                    |
| ----------------- | ------------------------------------------- | -------------------------------------------------------- |
| `content-type`    | `application/json;charset=utf-8`            | Required                                                 |
| `origin`          | `https://www.tripadvisor.com`               | Required                                                 |
| `referer`         | The hotel review URL                        | Required same-origin context                             |
| `x-requested-by`  | The `TAUnique` token value                  | Generated per attempt or taken from the server bootstrap |
| `cookie`          | All bootstrap cookies, including `TAUnique` | The server-issued `TAUnique` is preserved and reused     |
| `accept`          | `*/*`                                       |                                                          |
| `accept-language` | `en-US,en;q=0.9`                            |                                                          |

A request without the `TAUnique` token/cookie is rejected with `HTTP 400`. The token is therefore mandatory, but it is not sufficient on its own: the request also needs a trusted (non-blocked) session.

## Query ID rotation

TripAdvisor uses server-side persisted queries keyed by `preRegisteredQueryId`. The ID changes when TripAdvisor deploys. Observed review query IDs:

| Query ID           | Observed     | Source                                                                    |
| ------------------ | ------------ | ------------------------------------------------------------------------- |
| `9365c2244f5b46a6` | 2025         | TripAdvisor hydration / community scraper                                 |
| `ef1a9f94012220d3` | May-Aug 2026 | `algo7/TripAdvisor-Review-Scraper`, `jios325/tripadvisor-reviews-scraper` |
| `51c593cb61092fe5` | Sep 2026     | `rajanjasanicrest/siox-global` reviews spider                             |
| `3d5e9aff1e00e113` | Oct 2026     | Discovered live from TripAdvisor page assets (current)                    |

The review operation is defined in TripAdvisor's page bundle as `{__key:0x3d5e9aff1e00,id:"3d5e9aff1e00e113",...}` bound to the component that renders `ReviewsProxy_getReviewListPageForLocation`.

The actor tries a known-good ID first (configured env, cached value, then built-in candidates) with impit. When the API rejects it (`PersistedQueryNotFound`, or a response missing the `ReviewsProxy_getReviewListPageForLocation` payload), the actor launches Patchright Chrome to rediscover the current operation, caches it, and continues fetching with impit.

## Failure diagnosis: `PersistedQueryNotFound`

A live probe of the endpoint produced the following results from a datacenter IP:

| Request                                                                          | Result                                |
| -------------------------------------------------------------------------------- | ------------------------------------- |
| No `TAUnique` token                                                              | `HTTP 400`                            |
| Valid-looking query IDs (all three above)                                        | `HTTP 200` + `PersistedQueryNotFound` |
| Clearly invalid IDs (`deadbeefdeadbeef`, `0000000000000000`, `zzzzzzzzzzzzzzzz`) | `HTTP 200` + `PersistedQueryNotFound` |
| Hotel page bootstrap                                                             | `HTTP 403` (DataDome challenge)       |

Because invalid and valid-looking query IDs return the identical error, `PersistedQueryNotFound` is a **generic block response for untrusted sessions**, not proof of a rotated ID. The real trigger is the DataDome-blocked session (page bootstrap `HTTP 403`) caused by datacenter/blocked IPs. With a trusted (residential) session the persisted query resolves, and then a rotated ID is what produces the error — which is why the actor uses both a residential session and Patchright rediscovery.

**Operational consequence:** a RESIDENTIAL proxy is required. TripAdvisor blocks datacenter IPs (including Apify datacenter proxy groups), so the input schema now defaults `proxyConfiguration` to the `RESIDENTIAL` group.

## Auto-healing and resilience design

The actor is designed to recover instead of failing:

1. **Trusted session bootstrap.** Each location bootstraps the hotel page to capture cookies and the server-issued `TAUnique`, and warns when the bootstrap is blocked.
2. **Dynamic header values.** A fresh `TAUnique`/`X-Requested-By` token is generated per attempt; the server-issued token is preferred when available so the cookie and header stay consistent.
3. **Query ID cache.** The active ID is read from `process.env.TRIPADVISOR_REVIEWS_QUERY_ID`, then the named key-value store `tripadvisor-reviews-scraper-cache` (key `CURRENT_REVIEW_QUERY`), then built-in candidates.
4. **Patchright rediscovery.** On a persisted-query rejection or an unexpected payload, Patchright Chrome loads the hotel page, reads the `<script src>` assets, and finds the current review query ID from the bundle that references `ReviewsProxy_getReviewListPageForLocation`. The discovered ID (plus any captured variables template and cookies) is cached for future runs.
5. **Session refresh.** Failed attempts re-bootstrap with a new proxy session and a different browser profile.
6. **Bounded retries with backoff.** `403`/`429`/`5xx`, timeouts, network errors, and non-JSON/blocked bodies are retried with capped exponential backoff and jitter, honoring `Retry-After`. Permanent graphql errors are surfaced without retrying.
7. **Per-location isolation.** One failing hotel does not abort the run; the actor records the failure and moves on. A run only fails when zero reviews are saved, with a message that points back to this file and the blocked-session cause.

## Query ID discovery architecture (Patchright → impit)

- **Patchright (Chrome, persistent context)** is used only to discover the current operation when the stored one is stale. It navigates the hotel page so TripAdvisor's JS runs, collects the page's `script[src]` asset URLs, and locates the review query ID in the bundle. A response-correlated network interception of `/data/graphql/ids` acts as a fallback and can also capture the operation's variables template.
- **impit** performs all bulk fetching (paginated review requests). This keeps data extraction fast and avoids browser overhead on normal runs.
- The discovered ID is stored in the named key-value store so subsequent runs (and scheduled runs) start with a known-good ID and skip discovery entirely.

## Browser profile evaluation

All impit browser profiles were tested against the live endpoint:

`chrome`, `chrome100`-`chrome151`, `firefox`, `firefox128`-`firefox144`, `okhttp`, `okhttp3`-`okhttp5`, `ios18`.

Every profile produced the same result from the blocked IP (`page 403`, `GraphQL 200 PersistedQueryNotFound`), confirming the failure is session/IP trust, not the TLS/header profile. The actor therefore defaults to `chrome` and rotates `chrome` → `firefox` → `ios18` across retries for resilience.

## Session and pagination

- A hotel page request is made first to obtain TripAdvisor session cookies and the server-issued `TAUnique`.
- Those cookies and the token are sent with the GraphQL request.
- Reviews are deduplicated by review ID before they are pushed to the dataset.
- The response path is `data.ReviewsProxy_getReviewListPageForLocation[0]`, which contains the review list.

## Full review collection (GraphQL + paginated HTML)

The persisted GraphQL review operation (`3d5e9aff1e00e113`, `useRecentReviews`) returns the newest **20** reviews with the richest field set, and it hard-caps at 20 regardless of the requested `limit` (verified: `limit` 20/50/100/200 all return 20) and ignores `offset`. The web review list is server-rendered, so additional reviews are collected from the paginated review pages:

- The actor first fetches the newest 20 reviews through the GraphQL operation (rich fields).
- For more reviews, it requests the server-rendered review pages at `...-Reviews-or{N}-...` offsets. Each page embeds **10** reviews in HTML, and successive offsets return different reviews (verified: offsets 0/20/40/60 return distinct review IDs).
- The HTML review blocks are parsed for review ID, URL, title, rating, review text, stay date, trip type, reviewer name/profile, contribution count, and hometown.
- Offsets advance by the parsed page size (10) until `results_wanted` is reached, a page adds no new reviews, or `max_pages` is reached.

`max_pages` therefore bounds the number of paginated HTML pages requested per hotel (about 10 reviews each), on top of the single GraphQL page.

## Field coverage

GraphQL review records include review ID, title, rating, text, language, published date, stay date, trip type, helpful votes, user details, management response, additional category ratings, and source/review URLs. Reviews collected from the paginated HTML pages provide review ID, URL, title, rating, text, published date, stay date, trip type, reviewer name/profile, contributions, and hometown; fields not present on the HTML page are omitted.
