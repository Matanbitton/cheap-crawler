import { chromium } from "playwright";

// Semaphore to limit concurrent browser launches and prevent resource exhaustion
// This prevents EAGAIN errors when too many browsers try to launch at once
class BrowserLaunchLimiter {
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
    this.activeLaunches = 0;
    this.waitQueue = [];
  }

  async acquire() {
    return new Promise((resolve) => {
      if (this.activeLaunches < this.maxConcurrent) {
        this.activeLaunches++;
        resolve();
      } else {
        this.waitQueue.push(resolve);
      }
    });
  }

  release() {
    this.activeLaunches--;

    // Process next waiting request
    if (this.waitQueue.length > 0) {
      const nextResolve = this.waitQueue.shift();
      this.activeLaunches++;
      nextResolve();
    }
  }
}

// Global limiter - ensures max 5 browsers launch concurrently
const browserLaunchLimiter = new BrowserLaunchLimiter(5);

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
const EMAIL_REGEX =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2,})?/gi;

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

function extractEmails(text = "") {
  if (!text) return [];
  const matches = text.match(EMAIL_REGEX);
  if (!matches) return [];
  return matches.map((email) => email.toLowerCase());
}

/**
 * Extract links from a page that are on the same domain
 * Uses DOM API for reliable link extraction
 */
async function extractSameDomainLinks(page, baseUrl) {
  try {
    const links = await page.evaluate((baseHostname) => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const extractedLinks = [];

      for (const anchor of anchors) {
        try {
          const href = anchor.getAttribute("href");
          if (!href) continue;

          // Resolve relative URLs
          const absoluteUrl = new URL(href, window.location.href).href;
          const urlObj = new URL(absoluteUrl);

          // Only include same domain and http/https
          if (
            urlObj.hostname === baseHostname &&
            (urlObj.protocol === "http:" || urlObj.protocol === "https:")
          ) {
            // Remove hash fragments
            extractedLinks.push(urlObj.href.split("#")[0]);
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }

      return [...new Set(extractedLinks)]; // Remove duplicates
    }, baseUrl.hostname);

    return links;
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
/**
 * Process a single URL - extracted for parallel processing
 */
async function processUrl(
  browser,
  url,
  baseUrl,
  visitedUrls,
  scrapedData,
  maxPages
) {
  // Skip if already visited or processing
  if (visitedUrls.has(url)) {
    return null;
  }

  visitedUrls.add(url);

  const page = await browser.newPage();

  try {
    page.setDefaultTimeout(30000);

    // Navigate to the page
    await page.goto(url, {
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

    console.log(
      `[Crawler] Scraped ${url} - Content length: ${cleanedContent.length}`
    );

    // Extract emails from the page content
    const pageEmails = new Set([
      ...extractEmails(metadata.content),
      ...cleanedParagraphs.flatMap((paragraph) => extractEmails(paragraph)),
    ]);

    // Store data
    const pageData = {
      url,
      title,
      headings: cleanedHeadings,
      paragraphs: cleanedParagraphs,
      content: cleanedContent,
      crawledAt: new Date().toISOString(),
    };

    // Extract links for same domain (if we haven't reached maxPages)
    let links = [];
    if (scrapedData.length + 1 < maxPages) {
      links = await extractSameDomainLinks(page, baseUrl);
    }

    return { pageData, links, emails: Array.from(pageEmails) };
  } catch (error) {
    console.error(`[Crawler] Error processing ${url}:`, error.message);
    return null;
  } finally {
    await page.close();
  }
}

export async function scrapeWebsite(url, maxPages = 10) {
  const scrapedData = [];
  const visitedUrls = new Set();
  const urlQueue = [url];
  const baseUrl = new URL(url);
  const maxConcurrency = 3; // Process up to 3 pages concurrently
  const emailSet = new Set();

  // Wait for permission to launch browser (limits concurrent launches)
  await browserLaunchLimiter.acquire();

  let browser;
  try {
    // Launch browser for this crawl - each crawl gets its own isolated browser
    browser = await chromium.launch({
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
  } catch (error) {
    // Release the semaphore if launch fails
    browserLaunchLimiter.release();
    throw error;
  }

  try {
    // Process URLs from queue until we reach maxPages or queue is empty
    while (urlQueue.length > 0 && scrapedData.length < maxPages) {
      // Get up to maxConcurrency URLs to process in parallel
      const urlsToProcess = [];
      while (
        urlsToProcess.length < maxConcurrency &&
        urlQueue.length > 0 &&
        scrapedData.length + urlsToProcess.length < maxPages
      ) {
        const nextUrl = urlQueue.shift();
        if (nextUrl && !visitedUrls.has(nextUrl)) {
          urlsToProcess.push(nextUrl);
        }
      }

      if (urlsToProcess.length === 0) {
        break;
      }

      // Process URLs in parallel
      const results = await Promise.all(
        urlsToProcess.map((currentUrl) =>
          processUrl(
            browser,
            currentUrl,
            baseUrl,
            visitedUrls,
            scrapedData,
            maxPages
          )
        )
      );

      // Process results
      for (const result of results) {
        if (result) {
          scrapedData.push(result.pageData);
          result.emails.forEach((email) => emailSet.add(email));

          // Add new links to queue
          for (const link of result.links) {
            if (!visitedUrls.has(link) && !urlQueue.includes(link)) {
              urlQueue.push(link);
            }
          }
        }
      }
    }
  } finally {
    // Always close the browser
    try {
      await browser.close();
    } catch (e) {
      // Ignore close errors
    }
    // Release the semaphore to allow next browser launch
    browserLaunchLimiter.release();
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
    emails: Array.from(emailSet),
  };
}
