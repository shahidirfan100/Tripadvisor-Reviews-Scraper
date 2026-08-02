## What does TripAdvisor Reviews Scraper do?

TripAdvisor Reviews Scraper collects structured hotel reviews from a public TripAdvisor hotel review page. Enter one hotel URL, choose how many reviews to collect, and receive dataset records containing ratings, review text, dates, trip details, reviewer information, management responses, and additional ratings when available.

This TripAdvisor data extractor is useful for hotel reputation monitoring, competitor research, guest-feedback analysis, travel market research, and dashboards. The Actor follows review pagination automatically and removes duplicate records before saving the dataset.

## Why use TripAdvisor Reviews Scraper?

- **Create a clean review dataset** - Collect consistent review records instead of copying feedback manually from individual pages.
- **Analyze guest experience** - Study ratings, review titles, full text, trip types, stay dates, helpful votes, and additional category ratings.
- **Monitor hotel reputation** - Schedule repeat runs in Apify to compare new review activity, ratings, and management responses over time.
- **Support competitive research** - Build comparable review datasets for hotels in the same destination by running the Actor once per hotel.
- **Connect results to workflows** - Export the dataset as JSON, CSV, Excel, or XML, or pass run results to spreadsheets, webhooks, and automation tools.
- **Control collection size** - Set a review limit and a page limit so each run matches your research or monitoring workflow.

No TripAdvisor API key is required. You only need a valid TripAdvisor hotel review page URL and an Apify run.

## What data can you extract from TripAdvisor?

Each saved dataset item represents one hotel review. Empty values are omitted from individual records when the source page does not provide them.

| Field | Type | Description |
|-------|------|-------------|
| `item_type` | String | Record type, currently `review`. |
| `review_id` | String | Unique TripAdvisor review identifier when available. |
| `location_id` | String | TripAdvisor identifier for the hotel or location. |
| `location_name` | String | Hotel or location name. |
| `location_type` | String | TripAdvisor place type when available. |
| `rating` | Number | Rating assigned to the review. |
| `title` | String | Review headline or title. |
| `review_text` | String | Full review text. |
| `language` | String | Language associated with the review. |
| `original_language` | String | Original review language when available. |
| `published_date` | String | Date the review was published. |
| `created_date` | String | Review creation date when available. |
| `trip_type` | String | Trip category, such as couples, family, or business. |
| `stay_date` | String | Date or period associated with the guest stay. |
| `helpful_votes` | Number | Number of helpful votes received by the review. |
| `user_id` | String | Reviewer identifier when available. |
| `user_name` | String | Reviewer display name or username. |
| `user_profile_url` | String | Link to the reviewer profile when available. |
| `user_contributions` | Number | Total user contributions when published by TripAdvisor. |
| `user_hometown` | String | Reviewer hometown or location when available. |
| `source_url` | String | Hotel review page used for the run. |
| `review_url` | String | Direct link to the individual review when available. |
| `management_response_text` | String | Response from the hotel or management team. |
| `management_response_date` | String | Date of the management response. |
| `additional_ratings` | Object | Category ratings, such as location, cleanliness, service, or value, when available. |
| `total_reviews_on_page` | Number | Total number of reviews reported for the selected hotel page. |

## How to scrape TripAdvisor hotel reviews

1. Open TripAdvisor Reviews Scraper in Apify Console.
2. Paste a TripAdvisor hotel review page URL into `startUrl`.
3. Set `results_wanted` to the maximum number of review records you want.
4. Set `max_pages` if you want to limit how many review pages are checked.
5. Optionally configure an Apify proxy for more consistent collection.
6. Start the run and open the dataset when it finishes.
7. Download the results or connect them to your reporting and automation workflow.

Use a canonical hotel URL containing a location segment such as `-d14930175-`. The Actor reads the hotel location identifier from the URL, so a hotel review page is required rather than a TripAdvisor search page or a general website URL.

## Input Parameters

All input parameters are optional because the Actor includes default values. For a predictable run, provide `startUrl` explicitly.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | Sample hotel URL | TripAdvisor hotel review page URL. It must contain the hotel location identifier in the URL. |
| `results_wanted` | Integer | No | `20` | Maximum number of unique reviews to save. Minimum value is `1`. |
| `max_pages` | Integer | No | `5` | Maximum number of review pages to check. Minimum value is `1`. |
| `proxyConfiguration` | Object | No | Apify proxy enabled by default in the input form | Optional Apify proxy settings. Residential proxy routing is recommended for more consistent runs. |

The prefilled URL is a sample TripAdvisor hotel page. Replace it with the hotel you want to analyze.

## Output Data

The main output is an Apify dataset containing one item per unique review. The Actor also stores a `RUN_INFO` record with run-level details such as the selected URL, location ID, requested review count, saved review count, pages fetched, and the last pagination offset.

| Field | Type | Description |
|-------|------|-------------|
| `item_type` | String | Always `review` for dataset items. |
| `review_id` | String | Review identifier. |
| `location_id` | String | Hotel location identifier. |
| `location_name` | String | Hotel name. |
| `location_type` | String | Location type. |
| `rating` | Number | Review rating. |
| `title` | String | Review title. |
| `review_text` | String | Review content. |
| `language` | String | Review language. |
| `original_language` | String | Original language. |
| `published_date` | String | Publication date. |
| `created_date` | String | Creation date, when available. |
| `stay_date` | String | Guest stay date or period. |
| `trip_type` | String | Trip category. |
| `helpful_votes` | Number | Helpful vote total. |
| `user_id` | String | Reviewer ID. |
| `user_name` | String | Reviewer name. |
| `user_profile_url` | String | Reviewer profile link. |
| `user_contributions` | Number | Reviewer contribution total. |
| `user_hometown` | String | Reviewer hometown. |
| `source_url` | String | Input hotel URL. |
| `review_url` | String | Individual review URL. |
| `management_response_text` | String | Hotel response text. |
| `management_response_date` | String | Hotel response date. |
| `additional_ratings` | Object | Category rating values. |
| `total_reviews_on_page` | Number | Total reviews reported for the hotel. |

## Usage Examples

### Basic hotel review extraction

Collect up to 20 reviews from one TripAdvisor hotel page using the default page limit.

```json
{
  "startUrl": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
  "results_wanted": 20
}
```

### Collect more reviews across additional pages

Request up to 100 unique reviews and allow the Actor to check up to 20 pages.

```json
{
  "startUrl": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
  "results_wanted": 100,
  "max_pages": 20
}
```

### Use Apify residential proxy routing

Enable residential proxy routing for a run that needs more consistent access to the selected hotel page.

```json
{
  "startUrl": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
  "results_wanted": 50,
  "max_pages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": [
      "RESIDENTIAL"
    ]
  }
}
```

## Sample Output

The following example shows one realistic dataset item. Fields may be omitted when TripAdvisor does not publish the corresponding value.

```json
{
  "item_type": "review",
  "review_id": "987654321",
  "location_id": "14930175",
  "location_name": "Sheraton Istanbul City Center",
  "location_type": "HOTEL",
  "rating": 5,
  "title": "Excellent stay in Istanbul",
  "review_text": "The room was clean, the staff were helpful, and the location made it easy to explore the city.",
  "language": "en",
  "original_language": "en",
  "published_date": "2026-06-18",
  "created_date": "2026-06-18T09:42:00Z",
  "trip_type": "Couples",
  "stay_date": "2026-06",
  "helpful_votes": 4,
  "user_id": "user-12345",
  "user_name": "TravelExplorer",
  "user_profile_url": "https://www.tripadvisor.com/Profile/TravelExplorer",
  "user_contributions": 18,
  "user_hometown": "London, United Kingdom",
  "source_url": "https://www.tripadvisor.com/Hotel_Review-g293974-d14930175-Reviews-Sheraton_Istanbul_City_Center-Istanbul.html",
  "review_url": "https://www.tripadvisor.com/ShowUserReviews-g293974-d14930175-r987654321-Sheraton_Istanbul_City_Center-Istanbul.html",
  "management_response_text": "Thank you for sharing your feedback. We are pleased you enjoyed your stay.",
  "management_response_date": "2026-06-20",
  "additional_ratings": {
    "Location": 5,
    "Cleanliness": 5,
    "Service": 5,
    "Value": 4
  },
  "total_reviews_on_page": 1287
}
```

## Tips for best results

- Use the complete hotel review page URL, including the `-d<locationId>-` segment.
- Start with `results_wanted: 20` to confirm that the URL and output meet your needs.
- Increase `max_pages` when you request a larger dataset. The Actor checks up to 20 reviews per page.
- Enable the recommended residential proxy option when a run is inconsistent or the source page is difficult to access.
- Run one hotel per Actor run. For a portfolio of hotels, create separate scheduled runs or trigger runs through the Apify API.
- Review the dataset preview before setting up a recurring schedule.
- Expect some fields to be empty or absent when the reviewer or hotel has not published that information.

## Integrations and export formats

- **Apify API** - Start runs, retrieve dataset items, and connect review data to your application.
- **Google Sheets** - Export review records for filtering, reporting, and team analysis.
- **Webhooks** - Notify another service when a run completes.
- **Make or Zapier** - Send new datasets into no-code workflows.
- **JSON** - Use structured records in applications, scripts, and data pipelines.
- **CSV or Excel** - Analyze ratings, dates, and review text in spreadsheet tools.
- **XML** - Provide records to systems that require XML exports.

## Frequently Asked Questions

### Can I scrape reviews from any TripAdvisor hotel?

Yes, provide the public TripAdvisor review page for the hotel you want to collect. The URL must contain the hotel location identifier, such as `-d14930175-`.

### Can I collect reviews from multiple hotels in one run?

No, the current input accepts one `startUrl` per run. Run the Actor separately for each hotel, or automate multiple runs with the Apify API.

### How many reviews can I collect?

You can request any positive `results_wanted` value, subject to the number of reviews available and the `max_pages` limit. Each page can provide up to 20 reviews.

### Does the Actor remove duplicate reviews?

Yes, duplicate records are filtered before they are saved to the dataset.

### Are empty fields included in the dataset?

No, empty and null values are omitted from individual review records. Fields can still be absent when TripAdvisor does not provide the information.

### Do I need a TripAdvisor API key?

No, this Actor does not require a TripAdvisor API key. Configure the input, start the run in Apify, and inspect the resulting dataset.

### Can I schedule TripAdvisor review collection?

Yes, create an Apify schedule to run the Actor hourly, daily, weekly, or at a custom interval. Scheduled snapshots can help track new reviews and changing ratings.

### What should I do if a run returns no reviews?

Confirm that `startUrl` is a valid public hotel review page with a `-d<locationId>-` segment. Try a smaller result limit, enable residential proxy routing, and report persistent problems through the Actor Issues tab.

### Can I export TripAdvisor reviews to CSV or Excel?

Yes, Apify datasets can be downloaded as CSV, Excel, JSON, XML, and other supported formats after the run completes.

### Is it legal to collect TripAdvisor reviews?

You are responsible for complying with applicable laws, TripAdvisor terms, privacy requirements, and any restrictions that apply to your use of the data. Collect and use publicly available review information responsibly.

## Related Actors

- [Tripadvisor Hotels Scraper](https://apify.com/shahidirfan/tripadvisor-hotels-scraper) - Collect hotel listings, ratings, review counts, pricing signals, amenities, and location details from TripAdvisor city and hotel listing pages.
- [Agoda Reviews Scraper](https://apify.com/shahidirfan/agoda-reviews-scraper) - Collect hotel ratings, guest feedback, review metadata, traveler segments, and reviewer context from Agoda property pages.

## Support

For setup questions, issue reports, or feature requests, use the Issues tab on the Actor page. Include the input URL, relevant run details, and the fields or behavior you expected so the problem can be investigated.

## Legal Notice

TripAdvisor Reviews Scraper is provided for legitimate research, monitoring, and analytics workflows using publicly accessible information. Users are responsible for complying with applicable laws, website terms, privacy rules, and any requirements related to storing or using reviewer-generated content.
