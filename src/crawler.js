// For more information, see https://crawlee.dev/
import { PlaywrightCrawler } from "crawlee";

/**
 * Scrapes a website and returns aggregated text content
 * @param {string} url - The starting URL to scrape
 * @param {number} maxPages - Maximum number of pages to scrape (default: 10)
 * @returns {Promise<{text: string, pagesScraped: number, urls: string[]}>}
 */
export async function scrapeWebsite(url, maxPages = 10) {
  // Collect scraped data in memory
  const scrapedData = [];

  const crawler = new PlaywrightCrawler({
    async requestHandler({ request, page, enqueueLinks, log }) {
      await page.waitForLoadState("domcontentloaded");
      // Give a bit of time for JavaScript-rendered content
      await page.waitForTimeout(1000);

      const title = await page.title();
      const metadata = await page.evaluate(() => {
        // Simple extraction - just get all text from the body
        const content = (document.body.innerText || document.body.textContent || "")
          .replace(/\s+/g, " ")
          .trim();

        const headings = Array.from(document.querySelectorAll("h1, h2, h3")).map(
          (heading) => ({
            level: heading.tagName,
            text: heading.innerText.trim(),
          })
        );

        const paragraphs = Array.from(document.querySelectorAll("p"))
          .map((p) => p.innerText.trim())
          .filter(Boolean);

        return { headings, paragraphs, content };
      });

      log.info(`Scraped ${request.loadedUrl}`);

      // Store data in memory instead of file storage
      scrapedData.push({
        url: request.loadedUrl,
        requestedUrl: request.url,
        title,
        ...metadata,
        crawledAt: new Date().toISOString(),
      });

      // Stay on the same domain while exploring links.
      await enqueueLinks({ strategy: "same-domain" });
    },
    maxRequestsPerCrawl: maxPages,
  });

  // Run the crawler
  await crawler.run([url]);

  // Aggregate all text content into a single string
  const aggregatedText = scrapedData
    .map((page) => page.content)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    text: aggregatedText,
    pagesScraped: scrapedData.length,
    urls: scrapedData.map((page) => page.url),
  };
}
