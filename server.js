import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TMDB_BASE = "https://api.themoviedb.org/3";

const TMDB_READ_TOKEN = (process.env.TMDB_READ_TOKEN || "").trim();
const TMDB_API_KEY = (process.env.TMDB_API_KEY || "").trim();

const CACHE_TTL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

const cache = new Map();
const rateBuckets = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.static(__dirname));

function clientIp(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const existing = rateBuckets.get(ip);

  if (!existing || now - existing.startedAt >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - existing.count)
  };
}

function cleanRateBuckets() {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) {
      rateBuckets.delete(ip);
    }
  }
}

setInterval(cleanRateBuckets, RATE_WINDOW_MS).unref();

function isAllowedTmdbPath(pathname) {
  const patterns = [
    /^\/trending\/(movie|tv|all)\/(day|week)$/
    ,/^\/movie\/(popular|top_rated)$/
    ,/^\/movie\/\d+$/
    ,/^\/movie\/\d+\/videos$/
    ,/^\/tv\/(popular|top_rated)$/
    ,/^\/tv\/\d+$/
    ,/^\/tv\/\d+\/videos$/
    ,/^\/tv\/\d+\/season\/\d+$/
    ,/^\/search\/multi$/
    ,/^\/search\/movie$/
    ,/^\/search\/tv$/
  ];

  return patterns.some((pattern) => pattern.test(pathname));
}

function getCacheKey(url) {
  return url.toString();
}

function getCached(url) {
  const key = getCacheKey(url);
  const item = cache.get(key);

  if (!item) return null;

  if (Date.now() - item.createdAt >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCached(url, data) {
  cache.set(getCacheKey(url), { createdAt: Date.now(), data });

  if (cache.size > 250) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
}

function hasTmdbCredentials() {
  return Boolean(TMDB_READ_TOKEN || TMDB_API_KEY);
}

app.get("/api/tmdb/*", async (req, res) => {
  const rate = checkRateLimit(req);

  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));

  if (!rate.allowed) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({
      error: "Too many requests. Please try again shortly."
    });
  }

  if (!hasTmdbCredentials()) {
    return res.status(503).json({
      error: "TMDB credentials are not configured on the server.",
      hint: "Set TMDB_READ_TOKEN or TMDB_API_KEY in the server environment."
    });
  }

  const requestedPath = "/" + (req.params[0] || "").replace(/^\/+/, "");

  if (!isAllowedTmdbPath(requestedPath)) {
    return res.status(404).json({
      error: "TMDB endpoint is not available through this proxy."
    });
  }

  const target = new URL(TMDB_BASE + requestedPath);

  for (const [key, value] of Object.entries(req.query)) {
    if (key === "api_key" || key === "access_token" || key === "authorization") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        target.searchParams.append(key, String(item));
      }
    } else if (value !== undefined && value !== null) {
      target.searchParams.set(key, String(value));
    }
  }

  if (!target.searchParams.has("language")) {
    target.searchParams.set("language", "en-US");
  }

  if (TMDB_API_KEY && !TMDB_READ_TOKEN) {
    target.searchParams.set("api_key", TMDB_API_KEY);
  }

  const cached = getCached(target);
  if (cached) {
    res.setHeader("X-MahiFlix-Cache", "HIT");
    return res.type("application/json").send(cached);
  }

  try {
    const headers = { accept: "application/json" };

    if (TMDB_READ_TOKEN) {
      headers.Authorization = "Bearer " + TMDB_READ_TOKEN;
    }

    const response = await fetch(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(12_000)
    });

    const text = await response.text();
    res.setHeader("X-MahiFlix-Cache", "MISS");

    if (!response.ok) {
      return res
        .status(response.status)
        .type(response.headers.get("content-type") || "application/json")
        .send(text);
    }

    setCached(target, text);

    return res
      .status(200)
      .type(response.headers.get("content-type") || "application/json")
      .send(text);
  } catch (error) {
    console.error("TMDB proxy error:", error);

    return res.status(502).json({
      error: "Unable to reach TMDB right now."
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MahiFlix",
    tmdbConfigured: hasTmdbCredentials()
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("MahiFlix server running on http://0.0.0.0:" + PORT);
});

// TMDB credentials are intentionally server-side only.
// Preferred: TMDB_READ_TOKEN
// Fallback:  TMDB_API_KEY