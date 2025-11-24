import express from "express";
import cors from "cors";
import { scrapeWebsite } from "./crawler.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT_REQUESTS || "10", 10);

// Middleware
app.use(cors());
app.use(express.json());

// Request queue for concurrency control
let activeRequests = 0;
const requestQueue = [];
const MAX_QUEUE_SIZE = 100;

function processQueue() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || requestQueue.length === 0) {
    return;
  }

  const { req, res, next } = requestQueue.shift();
  activeRequests++;

  // Process the request
  handleScrapeRequest(req, res)
    .finally(() => {
      activeRequests--;
      processQueue(); // Process next request in queue
    });
}

/**
 * Estimates token count (rough approximation: 1 token ≈ 4 characters)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
function estimateTokens(text) {
  if (!text) return 0;
  // Rough approximation: 1 token ≈ 4 characters
  // This is a conservative estimate for English text
  return Math.ceil(text.length / 4);
}

async function handleScrapeRequest(req, res) {
  try {
    const { url, maxPages = 10, maxLength } = req.body;

    // Validate URL
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Validate maxPages
    const pagesToScrape = Math.min(Math.max(1, parseInt(maxPages, 10) || 10), 50);
    if (isNaN(pagesToScrape) || pagesToScrape < 1) {
      return res.status(400).json({ error: "maxPages must be a positive number (max 50)" });
    }

    // Validate maxLength (optional, in characters)
    let maxLengthLimit = null;
    if (maxLength !== undefined) {
      maxLengthLimit = parseInt(maxLength, 10);
      if (isNaN(maxLengthLimit) || maxLengthLimit < 1) {
        return res.status(400).json({ error: "maxLength must be a positive number" });
      }
      // Cap at 100k characters to prevent abuse
      maxLengthLimit = Math.min(maxLengthLimit, 100000);
    }

    // Scrape the website
    const result = await scrapeWebsite(url, pagesToScrape);

    // Apply maxLength limit if specified
    let truncated = false;
    let originalLength = result.text.length;
    if (maxLengthLimit && result.text.length > maxLengthLimit) {
      result.text = result.text.substring(0, maxLengthLimit) + "...";
      truncated = true;
    }

    // Calculate token estimate
    const tokenEstimate = estimateTokens(result.text);
    const originalTokenEstimate = truncated ? estimateTokens(result.text.substring(0, originalLength)) : tokenEstimate;

    // Return result with additional metadata
    res.json({
      text: result.text,
      pagesScraped: result.pagesScraped,
      urls: result.urls,
      tokenEstimate,
      originalTokenEstimate: truncated ? originalTokenEstimate : undefined,
      characterCount: result.text.length,
      originalCharacterCount: truncated ? originalLength : undefined,
      truncated,
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({
      error: "Failed to scrape website",
      message: error.message,
    });
  }
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    activeRequests,
    queueLength: requestQueue.length,
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
  });
});

// Scrape endpoint with concurrency control
app.post("/scrape", (req, res, next) => {
  // Check if we can process immediately
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    handleScrapeRequest(req, res)
      .finally(() => {
        activeRequests--;
        processQueue();
      });
  } else if (requestQueue.length < MAX_QUEUE_SIZE) {
    // Add to queue
    requestQueue.push({ req, res, next });
  } else {
    // Queue is full
    res.status(503).json({
      error: "Service temporarily unavailable",
      message: "Request queue is full. Please try again later.",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Scraping API server running on port ${PORT}`);
  console.log(`Max concurrent requests: ${MAX_CONCURRENT_REQUESTS}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

