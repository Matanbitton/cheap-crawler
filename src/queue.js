import { Queue, Worker, QueueEvents } from "bullmq";
import Redis from "ioredis";

// Redis connection - Railway provides REDIS_URL env var
const redisConnection = new Redis(
  process.env.REDIS_URL || "redis://localhost:6379",
  {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
);

// Create queue for scraping jobs
export const scrapeQueue = new Queue("scrape-jobs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000,
    },
    removeOnFail: {
      age: 86400, // Keep failed jobs for 24 hours
    },
  },
});

export const queueEvents = new QueueEvents("scrape-jobs", {
  connection: redisConnection,
});

queueEvents.waitUntilReady().catch((error) => {
  console.error("[QueueEvents] Failed to initialize queue events", error);
});

// Worker to process scraping jobs
export function createWorker(processJob) {
  return new Worker("scrape-jobs", processJob, {
    connection: redisConnection,
    concurrency: 1, // Process one job at a time per worker
    limiter: {
      max: 1,
      duration: 2000, // Max 1 job per 2 seconds per worker
    },
  });
}

export { redisConnection };
