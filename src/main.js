// For more information, see https://crawlee.dev/
import { scrapeWebsite } from "./crawler.js";

const { START_URLS, START_URL, MAX_PAGES } = process.env;

const cliStartArg = process.argv[2];

const startUrls = (
  START_URLS ??
  START_URL ??
  cliStartArg ??
  "https://www.gemresourcing.com/"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const maxPages = MAX_PAGES ? Number(MAX_PAGES) : 20;

// CLI mode: scrape the first URL and print results
const url = startUrls[0];
console.log(`Starting crawl of ${url} (max ${maxPages} pages)...`);

const result = await scrapeWebsite(url, maxPages);

console.log(`\nScraped ${result.pagesScraped} pages`);
console.log(`Total text length: ${result.text.length} characters`);
console.log(`\nAggregated text:\n${result.text.substring(0, 500)}...`);
