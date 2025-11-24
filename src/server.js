import express from "express";
import cors from "cors";
import { scrapeQueue, queueEvents } from "./queue.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Track active requests (for monitoring)
let activeRequests = 0;

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
    const pagesToScrape = Math.min(
      Math.max(1, parseInt(maxPages, 10) || 10),
      50
    );
    if (isNaN(pagesToScrape) || pagesToScrape < 1) {
      return res
        .status(400)
        .json({ error: "maxPages must be a positive number (max 50)" });
    }

    // Validate maxLength (optional, in characters)
    let maxLengthLimit = null;
    if (maxLength !== undefined) {
      maxLengthLimit = parseInt(maxLength, 10);
      if (isNaN(maxLengthLimit) || maxLengthLimit < 1) {
        return res
          .status(400)
          .json({ error: "maxLength must be a positive number" });
      }
      // Cap at 100k characters to prevent abuse
      maxLengthLimit = Math.min(maxLengthLimit, 100000);
    }

    // Add job to queue
    const job = await scrapeQueue.add(
      "scrape",
      {
        url,
        maxPages: pagesToScrape,
        maxLength: maxLengthLimit,
      },
      {
        jobId: `scrape-${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}`,
      }
    );

    // Wait for job to complete (with timeout)
    const timeout = 300000; // 5 minutes max
    const result = await Promise.race([
      job.waitUntilFinished(queueEvents),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Job timeout")), timeout)
      ),
    ]);

    // Return result
    res.json(result);
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({
      error: "Failed to scrape website",
      message: error.message,
    });
  }
}

// Health check endpoint
app.get("/health", async (req, res) => {
  const waiting = await scrapeQueue.getWaitingCount();
  const active = await scrapeQueue.getActiveCount();
  const completed = await scrapeQueue.getCompletedCount();
  const failed = await scrapeQueue.getFailedCount();

  res.json({
    status: "ok",
    queue: {
      waiting,
      active,
      completed,
      failed,
    },
    activeRequests,
  });
});

// Scrape endpoint - uses Redis queue
app.post("/scrape", async (req, res) => {
  activeRequests++;
  try {
    await handleScrapeRequest(req, res);
  } finally {
    activeRequests--;
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Scraping API server running on port ${PORT}`);
  console.log(`Using Redis queue for job processing`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
