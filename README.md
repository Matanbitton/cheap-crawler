# Website Scraper API

A web scraping service built with Crawlee and Playwright that can crawl websites and extract aggregated text content. Supports both CLI and REST API modes.

## Features

- Crawls entire websites (up to configurable page limit)
- **Smart content extraction**: Focuses on main content areas, removes navigation, headers, footers
- **Text optimization**: Filters out cookie notices, privacy policies, and other noise
- **Duplicate removal**: Automatically removes duplicate and near-duplicate content
- Extracts and aggregates all text content from pages
- **LLM-optimized**: Returns token estimates and supports text length limits for efficient LLM processing
- REST API for programmatic access
- Concurrent request handling for high throughput
- CLI mode for direct usage
- Docker support for easy deployment

## Installation

```bash
npm install
```

## Usage

### API Server Mode

Start the API server:

```bash
npm run server
```

The server will start on port 3000 (or the port specified in `PORT` environment variable).

#### API Endpoints

##### POST /scrape

Scrapes a website and returns aggregated text content.

**Request Body:**
```json
{
  "url": "https://example.com",
  "maxPages": 10,
  "maxLength": 10000
}
```

**Parameters:**
- `url` (required): The starting URL to scrape
- `maxPages` (optional): Maximum number of pages to scrape (default: 10, max: 50)
- `maxLength` (optional): Maximum character length for aggregated text (default: no limit, max: 100,000). Useful for controlling LLM token costs.

**Response:**
```json
{
  "text": "Aggregated text content from all scraped pages...",
  "pagesScraped": 10,
  "urls": [
    "https://example.com",
    "https://example.com/about",
    ...
  ],
  "tokenEstimate": 2500,
  "characterCount": 10000,
  "truncated": false
}
```

**Response Fields:**
- `text`: Aggregated text content (optimized for LLM consumption)
- `pagesScraped`: Number of pages successfully scraped
- `urls`: Array of URLs that were scraped
- `tokenEstimate`: Estimated token count (1 token ≈ 4 characters)
- `characterCount`: Total character count of the text
- `originalTokenEstimate`: Original token estimate before truncation (only present if truncated)
- `originalCharacterCount`: Original character count before truncation (only present if truncated)
- `truncated`: Boolean indicating if text was truncated due to maxLength

**Examples:**

Basic request:
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxPages": 10}'
```

With text length limit (for LLM cost control):
```bash
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxPages": 10, "maxLength": 5000}'
```

##### GET /health

Health check endpoint that returns server status and queue information.

**Response:**
```json
{
  "status": "ok",
  "activeRequests": 2,
  "queueLength": 5,
  "maxConcurrent": 10
}
```

### CLI Mode

Run the crawler directly from the command line:

```bash
npm start -- <url>
```

If you omit the URL, it defaults to `https://www.gemresourcing.com/`. You can also use environment variables:

```bash
START_URL=https://example.com npm start
START_URLS="https://example.com,https://example.com/blog" npm start
MAX_PAGES=50 npm start
```

The crawler stays on the same domain, downloads each page, extracts headings, paragraphs, and full text content, and displays the aggregated results.

## Environment Variables

- `PORT`: Port for the API server (default: 3000)
- `MAX_CONCURRENT_REQUESTS`: Maximum number of concurrent scraping requests (default: 10)
- `START_URL`: Starting URL for CLI mode
- `START_URLS`: Comma-separated list of starting URLs for CLI mode
- `MAX_PAGES`: Maximum pages to crawl (default: 20 for CLI, 10 for API)

## Docker

Build and run with Docker:

```bash
docker build -t website-scraper .
docker run -p 3000:3000 website-scraper
```

The Docker container runs the API server by default. To run CLI mode, override the CMD:

```bash
docker run website-scraper npm start -- https://example.com
```

## Concurrency

The API server handles concurrent requests efficiently:
- Default: 10 concurrent requests
- Requests beyond the limit are queued (max queue size: 100)
- Queue full returns HTTP 503

For processing 1000+ websites, you can:
1. Increase `MAX_CONCURRENT_REQUESTS` based on your server resources
2. Make parallel requests to the API from your client
3. Deploy multiple instances behind a load balancer

## Examples

### JavaScript/Node.js

```javascript
const response = await fetch('http://localhost:3000/scrape', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com',
    maxPages: 10,
    maxLength: 5000  // Limit to ~1250 tokens
  })
});

const data = await response.json();
console.log(`Scraped ${data.pagesScraped} pages`);
console.log(`Estimated tokens: ${data.tokenEstimate}`);
console.log(`Text length: ${data.characterCount} characters`);
if (data.truncated) {
  console.log(`Warning: Text was truncated from ${data.originalCharacterCount} characters`);
}
console.log(data.text);
```

### Python

```python
import requests

response = requests.post('http://localhost:3000/scrape', json={
    'url': 'https://example.com',
    'maxPages': 10,
    'maxLength': 5000  # Limit to ~1250 tokens
})

data = response.json()
print(f"Scraped {data['pagesScraped']} pages")
print(f"Estimated tokens: {data['tokenEstimate']}")
print(f"Text length: {data['characterCount']} characters")
if data.get('truncated'):
    print(f"Warning: Text was truncated from {data['originalCharacterCount']} characters")
print(data['text'])
```

## Text Optimization for LLM Usage

The scraper is optimized for feeding content to LLMs:

1. **Smart Content Extraction**: Automatically finds and extracts main content areas (`<article>`, `<main>`, etc.) while skipping navigation, headers, and footers.

2. **Noise Filtering**: Removes common noise patterns like:
   - Cookie notices
   - GDPR/privacy policy text
   - Navigation menus
   - Social media widgets
   - Newsletter signups

3. **Duplicate Removal**: Automatically filters out duplicate and near-duplicate content across pages.

4. **Text Length Control**: Use the `maxLength` parameter to limit text size and control token costs.

5. **Token Estimation**: Response includes token estimates to help you budget LLM API costs.

**Example token costs:**
- 5,000 characters ≈ 1,250 tokens ≈ $0.0375 (GPT-4 input)
- 10,000 characters ≈ 2,500 tokens ≈ $0.075 (GPT-4 input)
- 20,000 characters ≈ 5,000 tokens ≈ $0.15 (GPT-4 input)

Use `maxLength` to keep costs predictable!

## References

- [Crawlee Documentation](https://crawlee.dev/js/docs/introduction)
- [PlaywrightCrawler API](https://crawlee.dev/js/api/playwright-crawler/class/PlaywrightCrawler)
- [Playwright Documentation](https://playwright.dev)
