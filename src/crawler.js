// For more information, see https://crawlee.dev/
import { PlaywrightCrawler, Configuration } from "crawlee";
import { MemoryStorage } from "@crawlee/memory-storage";

const COOKIE_PATTERNS = [
  /cookie/i,
  /cookies/i,
  /gdpr/i,
  /privacy policy/i,
  /privacy settings/i,
  /consent/i,
  /accept all/i,
  /reject all/i,
  /manage preferences/i,
  /personalized ads/i,
  /we value your privacy/i,
  /tracking technologies/i,
];

const COOKIE_SECTION_SPLIT_REGEX = /\n{2,}|\r{2,}/;

function isCookieText(text = "") {
  if (!text) return false;
  return COOKIE_PATTERNS.some((pattern) => pattern.test(text));
}

function removeCookieSections(text = "") {
  if (!text) return "";

  const sections = text
    .replace(/\r\n/g, "\n")
    .split(COOKIE_SECTION_SPLIT_REGEX)
    .map((section) => section.trim())
    .filter(Boolean);

  const filtered = sections
    .filter((section) => {
      if (!section) return false;
      // Drop sections that are mostly cookie text or very short and contain cookie keywords
      if (isCookieText(section) && section.length <= 1200) {
        return false;
      }
      // Drop sections that mention cookies multiple times even if long
      const keywordMatches = COOKIE_PATTERNS.reduce((count, pattern) => {
        const matches = section.match(pattern);
        return count + (matches ? matches.length : 0);
      }, 0);
      if (keywordMatches >= 2) {
        return false;
      }
      return true;
    })
    .map((section) => section.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return filtered.join("\n\n").trim();
}

/**
 * Scrapes a website and returns aggregated text content
 * @param {string} url - The starting URL to scrape
 * @param {number} maxPages - Maximum number of pages to scrape (default: 10)
 * @returns {Promise<{text: string, pagesScraped: number, urls: string[]}>}
 */
export async function scrapeWebsite(url, maxPages = 10) {
  // We only need storage to create an isolated request queue for this crawl
  // This prevents concurrent crawls from seeing each other's enqueued URLs
  // We don't use storage for data - we collect everything in scrapedData array
  // Use a unique temp directory for each crawl - /tmp should always exist on Railway
  const tempDir = `/tmp/crawlee-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const storage = new MemoryStorage({
    localDataDirectory: tempDir,
  });

  // Set the storage in Configuration so the crawler uses it
  // Each crawl gets its own storage instance, so request queues are isolated
  // We set it before creating the crawler, and the crawler captures the reference
  // We don't restore it afterward to avoid race conditions with concurrent crawls
  const config = Configuration.getGlobalConfig();
  config.set("storageClient", storage);

  try {
    // Create a unique request queue for this crawl to ensure complete isolation
    // Each crawl gets its own queue name, preventing any cross-contamination
    const queueId = `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const requestQueue = await storage.requestQueues().getOrCreate(queueId);

    // Collect scraped data in memory (we don't use Crawlee's storage for data)
    const scrapedData = [];

    const crawler = new PlaywrightCrawler({
      // Use our unique request queue
      requestQueue,
      // Disable session pool to avoid file system access issues
      useSessionPool: false,
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
            const content = (
              document.body.innerText ||
              document.body.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim();

            const headings = Array.from(
              document.querySelectorAll("h1, h2, h3")
            ).map((heading) => ({
              level: heading.tagName,
              text: heading.innerText.trim(),
            }));

            const paragraphs = Array.from(document.querySelectorAll("p"))
              .map((p) => p.innerText.trim())
              .filter(Boolean);

            return { headings, paragraphs, content };
          });

          const cleanedParagraphs = metadata.paragraphs
            .map((paragraph) => removeCookieSections(paragraph))
            .filter(Boolean);
          const cleanedHeadings = metadata.headings
            .map((heading) => ({
              ...heading,
              text: removeCookieSections(heading.text),
            }))
            .filter((heading) => heading.text.length > 0);
          const cleanedContent = removeCookieSections(metadata.content);

          log.info(
            `Scraped ${request.loadedUrl} - Content length: ${cleanedContent.length}`
          );

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
        } finally {
          // Ensure page is closed to free resources
          try {
            await page.close();
          } catch (e) {
            // Ignore close errors
          }
        }
      },
      maxRequestsPerCrawl: maxPages,
      requestHandlerTimeoutSecs: 60, // 60 second timeout per page
      maxConcurrency: 3, // Process up to 3 pages concurrently per website for faster crawling
      // Use headless browser with minimal resources
      launchContext: {
        launchOptions: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--disable-gpu",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
          ],
        },
      },
      // Ensure browsers are properly closed
      postNavigationHooks: [
        async ({ page }) => {
          // Clean up after navigation
          try {
            await page.evaluate(() => {
              // Clear any heavy resources
              if (window.stop) window.stop();
            });
          } catch (e) {
            // Ignore
          }
        },
      ],
    });

    // Run the crawler - ensure the URL is properly formatted
    try {
      await crawler.run([url]);
    } catch (error) {
      console.error(`[Crawler] Error running crawler for ${url}:`, error);
      throw error;
    }

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
  // Note: We don't restore the global config here because:
  // 1. Each crawler captures its storage reference when created, so it's safe
  // 2. Restoring would cause race conditions with concurrent crawls
  // 3. Each new crawl will set its own storage anyway
}
