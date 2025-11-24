import { chromium } from "playwright";

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
 * Extract links from a page that are on the same domain
 */
function extractSameDomainLinks(pageUrl, html) {
  try {
    const baseUrl = new URL(pageUrl);
    const links = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      try {
        const href = match[1];
        // Resolve relative URLs
        const absoluteUrl = new URL(href, baseUrl).href;
        const urlObj = new URL(absoluteUrl);
        
        // Only include same domain
        if (urlObj.hostname === baseUrl.hostname) {
          links.push(absoluteUrl);
        }
      } catch (e) {
        // Invalid URL, skip
      }
    }

    return [...new Set(links)]; // Remove duplicates
  } catch (e) {
    return [];
  }
}

/**
 * Scrapes a website and returns aggregated text content
 * Uses Playwright directly - no Crawlee, no shared state, fully isolated
 * @param {string} url - The starting URL to scrape
 * @param {number} maxPages - Maximum number of pages to scrape (default: 10)
 * @returns {Promise<{text: string, pagesScraped: number, urls: string[]}>}
 */
export async function scrapeWebsite(url, maxPages = 10) {
  const scrapedData = [];
  const visitedUrls = new Set();
  const urlQueue = [url];
  const baseUrl = new URL(url);

  // Launch browser for this crawl - completely isolated
  const browser = await chromium.launch({
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
  });

  try {
    // Process URLs from queue until we reach maxPages or queue is empty
    while (urlQueue.length > 0 && scrapedData.length < maxPages) {
      const currentUrl = urlQueue.shift();

      // Skip if already visited
      if (visitedUrls.has(currentUrl)) {
        continue;
      }

      visitedUrls.add(currentUrl);

      try {
        // Create a new page for each request - fully isolated
        const page = await browser.newPage();
        
        try {
          page.setDefaultTimeout(30000);

          // Navigate to the page
          await page.goto(currentUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });

          // Wait a bit for JavaScript-rendered content
          await page.waitForTimeout(1000);

          // Extract content
          const title = await page.title();
          const metadata = await page.evaluate(() => {
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

            return { headings, paragraphs, content, html: document.documentElement.outerHTML };
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

          console.log(`[Crawler] Scraped ${currentUrl} - Content length: ${cleanedContent.length}`);

          // Store data
          scrapedData.push({
            url: currentUrl,
            title,
            headings: cleanedHeadings,
            paragraphs: cleanedParagraphs,
            content: cleanedContent,
            crawledAt: new Date().toISOString(),
          });

          // Extract links for same domain and add to queue (if we haven't reached maxPages)
          if (scrapedData.length < maxPages) {
            const links = extractSameDomainLinks(currentUrl, metadata.html);
            for (const link of links) {
              if (!visitedUrls.has(link) && !urlQueue.includes(link)) {
                urlQueue.push(link);
              }
            }
          }
        } finally {
          // Always close the page
          await page.close();
        }
      } catch (error) {
        console.error(`[Crawler] Error processing ${currentUrl}:`, error.message);
        // Continue with next URL
      }
    }
  } finally {
    // Always close the browser
    await browser.close();
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
