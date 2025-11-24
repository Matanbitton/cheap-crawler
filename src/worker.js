import { createWorker } from "./queue.js";
import { scrapeWebsite } from "./crawler.js";

// Create worker to process scraping jobs
const worker = createWorker(async (job) => {
  const { url, maxPages = 10, maxLength } = job.data;

  console.log(`[Worker] Processing job ${job.id} for URL: ${url}`);

  try {
    // Scrape the website
    const result = await scrapeWebsite(url, maxPages);

    // Apply maxLength limit if specified
    let truncated = false;
    let originalLength = result.text.length;
    if (maxLength && result.text.length > maxLength) {
      result.text = result.text.substring(0, maxLength) + "...";
      truncated = true;
    }

    // Calculate token estimate
    const tokenEstimate = Math.ceil(result.text.length / 4);
    const originalTokenEstimate = truncated
      ? Math.ceil(originalLength / 4)
      : tokenEstimate;

    console.log(
      `[Worker] Completed job ${job.id} - Scraped ${result.pagesScraped} pages`
    );

    return {
      text: result.text,
      pagesScraped: result.pagesScraped,
      urls: result.urls,
      tokenEstimate,
      originalTokenEstimate: truncated ? originalTokenEstimate : undefined,
      characterCount: result.text.length,
      originalCharacterCount: truncated ? originalLength : undefined,
      truncated,
    };
  } catch (error) {
    console.error(`[Worker] Error processing job ${job.id}:`, error);
    throw error; // Let BullMQ handle retries
  }
});

// Worker event handlers
worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[Worker] Worker error:", err);
});

console.log("[Worker] Scraping worker started and ready to process jobs");
