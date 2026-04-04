import rateLimit from "express-rate-limit";
import { CONFIG } from "../config";

/**
 * Rate limiter for webhook endpoint.
 * Uses in-memory store — suitable for single Cloud Function instance.
 * For production at scale, consider a distributed rate limiter (e.g., Redis).
 */
export const webhookRateLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — try again later" },
  keyGenerator: (req) => {
    // Rate limit by IP
    return req.ip || req.headers["x-forwarded-for"]?.toString() || "unknown";
  },
});
