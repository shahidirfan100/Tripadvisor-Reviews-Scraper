# TripAdvisor Reviews Scraper

Extract TripAdvisor hotel user reviews into a clean dataset for research, analytics, and travel intelligence workflows. This actor is API-based with paginated review retrieval, null value cleanup, and duplicate filtering.

## Features

- **TripAdvisor review extraction** — Collect review records from a hotel page URL.
- **Duplicate-safe output** — Automatically removes duplicate review items.
- **Null-free dataset** — Skips empty or null fields from every output item.
- **Pagination support** — Retrieves reviews page-by-page using API `offset` and `limit`.

---

## Use Cases

### Reputation Monitoring
Track rating changes and review trends for a hotel over time. Build recurring snapshots to compare service perception month by month.

### Competitive Benchmarking
Compare ranking, review volume, and guest sentiment between competing hotels in the same city.

### Travel Market Research
Create structured datasets of guest feedback to identify frequent complaints, high-performing amenities, and seasonal patterns.

### BI and Dashboards
Export review data to analytics tools and visualize rating distribution, helpful-vote trends, and review cadence.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `startUrl` | String | Yes | Sheraton Istanbul sample URL | TripAdvisor hotel review page URL. |
| `results_wanted` | Integer | No | `20` | Maximum number of reviews to collect. |
| `max_pages` | Integer | No | `5` | Safety cap for pagination operations. |
| `proxyConfiguration` | Object | No | Residential proxy preset | Proxy settings for reliability and anti-blocking resilience. |

Environment variable required:

- `TRIPADVISOR_API_KEY` — TripAdvisor Content API key used by the actor.

---

## Output Data

Each dataset item contains only non-empty fields. The actor outputs review records.

| Field | Type | Description |
|---|---|---|
| `item_type` | String | `review`. |
| `review_id` | String | Unique review identifier. |
| `location_id` | String | TripAdvisor location identifier. |
| `location_name` | String | Hotel name. |
| `rating` | Number | Review rating or overall location rating. |
| `title` | String | Review headline. |
| `review_text` | String | Full review content. |
| `published_date` | String | Review publication date. |
| `stay_date` | String | Stay/trip date when available. |
| `trip_type` | String | Trip category (for example family, business). |
| `helpful_votes` | Number | Helpful vote count. |
| `user_name` | String | Reviewer display name. |
| `user_location` | String | Reviewer location. |
| `source_url` | String | Source TripAdvisor URL. |

---

## Usage Examples

### Basic Run

```json
{
	"startUrl": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
	"results_wanted": 20
}
```

### Extended Pagination

```json
{
	"startUrl": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
	"results_wanted": 100,
	"max_pages": 20,
	"proxyConfiguration": {
		"useApifyProxy": true,
		"apifyProxyGroups": ["RESIDENTIAL"]
	}
}
```

---

## Sample Output

```json
{
	"item_type": "review",
	"review_id": "123456789",
	"location_id": "14930175",
	"location_name": "Sheraton Istanbul City Center",
	"rating": 5,
	"title": "Excellent stay in Istanbul",
	"review_text": "Great service, clean rooms, and very convenient location.",
	"published_date": "2026-03-12",
	"stay_date": "2026-03",
	"trip_type": "Couples",
	"helpful_votes": 3,
	"user_name": "TravelExplorer",
	"user_location": "London, United Kingdom",
	"source_url": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html"
}
```

---

## Tips For Best Results

### Start With 20 Results
Use `results_wanted: 20` for quick validation runs and faster QA-friendly execution.

### Prefer Residential Proxies
Residential proxy routing improves reliability for protected pages and reduces blocked runs.

### Use Stable Hotel URLs
Use canonical TripAdvisor hotel URLs containing the `-d<locationId>-` segment to ensure reliable ID extraction.

---

## Integrations

- **Google Sheets** — Share hotel review datasets with non-technical teams.
- **Airtable** — Build searchable review repositories.
- **Make** — Automate review ingestion pipelines.
- **Zapier** — Trigger notifications on fresh run data.
- **Webhooks** — Push new records into custom backend services.

### Export Formats

- **JSON** — Best for APIs and downstream processing.
- **CSV** — Best for spreadsheet analysis.
- **Excel** — Best for reports and stakeholder sharing.
- **XML** — Best for legacy integrations.

---

## Frequently Asked Questions

### Why does the run fail with missing API key?
This actor uses the TripAdvisor reviews API directly and requires `TRIPADVISOR_API_KEY` in the runtime environment.

### Does this actor remove duplicate reviews?
Yes. Duplicate entries are filtered before writing to the dataset.

### Are null values included in output?
No. Empty and null fields are removed automatically from every saved item.

### Can I scrape multiple hotels?
This actor is optimized for one hotel per run. Schedule multiple runs for multiple hotels.

### How do I improve blocked runs?
Enable proxy routing with residential IPs and keep result limits reasonable.

---

## Support

For issues or feature requests, use the Apify Console issue/support channels for this actor.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for legitimate data collection and analytics workflows. You are responsible for compliance with applicable laws, platform terms, and internal usage policies.