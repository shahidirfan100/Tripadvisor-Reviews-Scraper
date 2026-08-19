# TripAdvisor Reviews API Discovery

## Selected API

- Endpoint: `https://www.tripadvisor.com/data/graphql/ids`
- Method: `POST`
- Authentication: no API key required
- Review query ID: `ef1a9f94012220d3`
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
      "preRegisteredQueryId": "ef1a9f94012220d3"
    }
  }
]
```

The `filters` value is an array of `{ axis, selections }` objects. Empty filters are sent as `[]`; the actor does not invent unsupported GraphQL filter axes.

## Supported actor inputs

| Actor input | GraphQL API value | Notes |
| --- | --- | --- |
| `searchText` | `{ "axis": "TEXT", "selections": ["..."] }` | Text search in review content |
| `lang` | `{ "axis": "LANGUAGE", "selections": ["en"] }` | Language code |
| `sortBy: MOST_RECENT` | `sortType: DEFAULT`, `sortBy: DATE` | API-supported recent ordering |
| `sortBy: HIGHEST_RATED` | `sortType: DEFAULT`, `sortBy: RATING` | API-supported rating ordering |

The actor sends only the supported text and language filters from the public input schema. Empty filters are sent as `[]`.

## Session and pagination

- A hotel page request is made first to obtain any TripAdvisor session cookies.
- Those cookies are sent with the GraphQL request. The hotel bootstrap can return HTTP 403/DataDome while still returning usable cookies.
- Each page uses the same filters and sort variables, so pagination does not change the requested result set.
- Reviews are deduplicated by review ID before they are pushed to the dataset.
- The response path is `data.ReviewsProxy_getReviewListPageForLocation[0]`, which contains `totalCount` and the review list.

## Field coverage

Review records include review ID, title, rating, text, language, published date, stay date, trip type, helpful votes, user details, management response, additional category ratings, and source/review URLs.
