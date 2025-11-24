// For more information, see https://crawlee.dev/
import { PlaywrightCrawler, Configuration } from "crawlee";

const COOKIE_PATTERNS = [
  /cookie/i,
  /cookies/i,
  /gdpr/i,
  /privacy policy/i,
  /privacy settings/i,
  /consent/i,
  /accept all/i,
  /reject all/i,
  /we value your privacy/i,
  /personalized ads/i,
];

function removeCookieText(text = "") {
  if (!text) return "";
  const containsCookieText = COOKIE_PATTERNS.some((pattern) => pattern.test(text));

  // If the entire block is cookie-related and short, drop it altogether
  if (containsCookieText && text.length <= 800) {
    return "";
  }

  let cleaned = text;
  COOKIE_PATTERNS.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });
  return cleaned.trim();
}

/**
 * Scrapes a website and returns aggregated text content
 * @param {string} url - The starting URL to scrape
 * @param {number} maxPages - Maximum number of pages to scrape (default: 10)
 * @returns {Promise<{text: string, pagesScraped: number, urls: string[]}>}
 */
export async function scrapeWebsite(url, maxPages = 10) {
  // Configure Crawlee to use in-memory storage to avoid file lock issues
  Configuration.getGlobalConfig().set("storageClientOptions", {
    persistStorage: false, // Don't persist to disk
  });

  // Collect scraped data in memory
  const scrapedData = [];

  const crawler = new PlaywrightCrawler({
    async requestHandler({ request, page, enqueueLinks, log }) {
      try {
        log.info(`Processing ${request.url}`);
        
        // Set reasonable timeouts
        page.setDefaultTimeout(30000); // 30 seconds
        
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
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

        const cleanedContent = removeCookieText(metadata.content);
        const cleanedParagraphs = metadata.paragraphs
          .map((paragraph) => removeCookieText(paragraph))
          .filter(Boolean);
        const cleanedHeadings = metadata.headings
          .map((heading) => ({
            ...heading,
            text: removeCookieText(heading.text),
          }))
          .filter((heading) => heading.text.length > 0);

        log.info(`Scraped ${request.loadedUrl} - Content length: ${cleanedContent.length}`);

        // Store data in memory instead of file storage
        scrapedData.push({
          url: request.loadedUrl,
          requestedUrl: request.url,
          title,
          headings: cleanedHeadings,
          paragraphs: cleanedParagraphs,
          content: cleanedContent,
          crawledAt: new Date().toISOString(),
        });

        // Stay on the same domain while exploring links.
        await enqueueLinks({ strategy: "same-domain" });
      } catch (error) {
        log.error(`Error processing ${request.url}: ${error.message}`);
        // Continue crawling even if one page fails
      }
    },
    maxRequestsPerCrawl: maxPages,
    requestHandlerTimeoutSecs: 60, // 60 second timeout per page
    maxConcurrency: 1, // Process one page at a time to avoid conflicts
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
