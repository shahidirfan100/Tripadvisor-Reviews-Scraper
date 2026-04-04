## Selected API

- Endpoint: `https://www.tripadvisor.com/data/graphql/ids`
- Method: `POST`
- Auth: no API key required
- Review query id: `ef1a9f94012220d3`
- Pagination: `offset` + `limit` (effective page size up to 20)
- Actor input used: hotel `startUrl` only (locationId derived from URL)

## Discovery Notes

- Direct HTTP access to the TripAdvisor hotel page often returns a DataDome challenge (HTTP 403), but still provides session cookies.
- Those cookies are sufficient to call the internal GraphQL reviews query without browser fallback.
- The GraphQL response includes `totalCount` and review items with rich fields (rating, title, text, user profile, trip info, management response).

## Pagination

- GraphQL pagination variables: `offset` + `limit` with query id `ef1a9f94012220d3`

## Field Coverage

- Review fields: review id, title, rating, text, language, published date, stay date, trip type, helpful votes, user details, management response, and additional category ratings
