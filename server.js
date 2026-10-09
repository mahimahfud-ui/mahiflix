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

// Optional gzip compression: used only if the "compression" package is installed.
try {
  const { default: compression } = await import("compression");
  app.use(compression());
} catch {}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Never serve server-side / build files through the static handler.
const PRIVATE_PATH = /^\/(?:server\.js|package(?:-lock)?\.json|Dockerfile|metadata\.json|scripts(?:\/|$)|\.github(?:\/|$)|\.git(?:\/|$)|node_modules(?:\/|$))/i;
app.use((req, res, next) => (PRIVATE_PATH.test(req.path) ? res.status(404).send("Not found.") : next()));
app.use(express.static(__dirname, {
  index: false,
  etag: true,
  setHeaders(res, filePath) {
    if (/[\\/](?:vendor|assets)[\\/]/.test(filePath) || /\.(?:svg|png|ico|webp)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

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


const APP_DOWNLOAD_CACHE_MS = 60_000;
const APP_DOWNLOAD_TIMEOUT_MS = 120_000;
const APP_RESOLVER_TIMEOUT_MS = 12_000;
const APP_MAX_REDIRECTS = 5;

const APP_DOWNLOADS = {
  "7reel": {
    page: "https://7reels.cc/download",
    fallback: null,
    allowedHosts: ["7reels.cc"],
    patterns: [/https?:\/\/[^"\']+\.apk(?:\?[^"\']*)?/i]
  },
  vega: {
    page: "https://api.github.com/repos/vega-org/vega-app/releases/latest",
    fallback: "https://github.com/vega-org/vega-app/releases/latest",
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => /\.apk$/i.test(String(name || "")) }
  },
  netmirror: {
    page: "https://netmirror.gg/10/en-us",
    fallback: "https://netmirror.gg/NetMirror.apk",
    allowedHosts: ["netmirror.gg"],
    patterns: [/https?:\/\/[^"'\s<>]+\.apk[^"'\s<>]*/i]
  },
  cinehd: {
    page: "https://cinehd.dev/",
    fallback: null,
    allowedHosts: ["cinehd.dev"],
    patterns: [/https?:\/\/[^"'\s<>]*CineHD[^"'\s<>]*Universal[^"'\s<>]*\.apk[^"'\s<>]*/i]
  },
  moviboxapk: {
    page: "https://moviboxapk.com/",
    fallback: null,
    allowedHosts: ["moviboxapk.com", "file.dxmaxapk.com"],
    patterns: [/https?:\/\/[^"'\s<>]+moviebox[^"'\s<>]*\.apk[^"'\s<>]*/i]
  },
  pvrplay: {
    page: "https://pvrplay.online/",
    fallback: "https://stream.phoasy.com/app/PvrPlay.apk",
    allowedHosts: ["pvrplay.online", "stream.phoasy.com"],
    patterns: [/https?:\/\/[^"'\s<>]*PvrPlay[^"'\s<>]*\.apk[^"'\s<>]*/i]
  },
  hdghartv: {
    page: "https://hdghartv.com.pk/apk/",
    fallback: null,
    allowedHosts: ["watch.hdghartv.com.pk", "hdghartv.com.pk", "download.hdghartv.com.pk"],
    patterns: [/https?:\/\/[^"'\s<>]+HDGharTV[^"'\s<>]*\.apk[^"'\s<>]*/i]
  },
  anivortex: {
    page: "https://anivortex.in/",
    fallback: null,
    allowedHosts: ["anivortex.in"],
    patterns: [/https?:\/\/[^"'\s<>]*\/apk\/[^"'\s<>]+\.apk[^"'\s<>]*/i]
  },
  filmtv: {
    page: "https://www.filmtvapp.com/",
    fallback: null,
    allowedHosts: ["www.filmtvapp.com", "filmtvapp.com"],
    patterns: [/https?:\/\/[^"'\s<>]+\.apk(?:\?[^"'\s<>]*)?/i]
  },
  nuvix: {
    page: "https://www.nuvixapp.in/",
    fallback: null,
    allowedHosts: ["www.nuvixapp.in", "nuvixapp.in"],
    patterns: [/https?:\/\/[^"'\s<>]+\.apk(?:\?[^"'\s<>]*)?/i]
  },
  "bitchord": {
    page: "https://api.github.com/repos/kushagrasinghx/BitChord/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "").startsWith("BitChord-v") && String(name || "").endsWith(".apk") && !String(name || "").includes("_") }
  },
  "echo-music": {
    page: "https://api.github.com/repos/EchoMusicApp/Echo-Music/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "") === "EchoMusic.apk" }
  },
  "echo-nightly": {
    page: "https://api.github.com/repos/itsmechinmoy/echo-nightly/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "") === "app-release.apk" }
  },
  outertune: {
    page: "https://api.github.com/repos/OuterTune/OuterTune/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "").includes("full-release-") && String(name || "").endsWith(".apk") }
  },
  lastwave: {
    page: "https://api.github.com/repos/Clash-Projects/LastWave-Native/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "").endsWith("-universal.apk") }
  },
  spotube: {
    page: "https://api.github.com/repos/team-spotube/spotube/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "") === "Spotube-android-all-arch.apk" }
  },
  dooflix: {
    page: "https://dooflixapk.com/",
    fallback: null,
    allowedHosts: ["dooflixapk.com", "www.dooflixapk.com"]
  },
  nxsha: {
    page: "https://api.github.com/repos/dev-alessiorizzo/nxsha-apk/releases/latest",
    fallback: null,
    allowedHosts: ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"],
    githubLatest: true,
    assetPattern: { test: (name) => String(name || "").endsWith(".Universal.apk") }
  }
};

const appDownloadCache = new Map();
const appDownloadInflight = new Map();
const APP_NEGATIVE_CACHE_MS = 15_000;

function normalizeHref(raw, baseUrl) {
  const value = String(raw)
    .replace(/&amp;/g, "&")
    .replace(/\\/g, "")
    .trim();

  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}

function allowedDownloadUrl(url, config) {
  return Boolean(
    url &&
    url.protocol === "https:" &&
    config.allowedHosts.includes(url.hostname) &&
    /\.(?:apk|xapk)$/i.test(url.pathname)
  );
}

function extractLatestApk(html, config, baseUrl = config.page) {
  const candidates = [];

  const addCandidate = (raw) => {
    const url = normalizeHref(raw, baseUrl);
    if (allowedDownloadUrl(url, config)) candidates.push(url.toString());
  };

  for (const pattern of config.patterns || []) {
    for (const match of html.matchAll(pattern)) addCandidate(match[0]);
  }

  // Handle relative APK links used by many download pages.
  for (const match of html.matchAll(/(?:href|src|data-href|data-url)\s*=\s*["']([^"']+\.(?:apk|xapk)(?:\?[^"']*)?)["']/gi)) {
    addCandidate(match[1]);
  }

  // Also catch quoted absolute/relative APK URLs embedded in scripts.
  for (const match of html.matchAll(/["']((?:https?:\/\/|\/)[^"'\s<>]+\.(?:apk|xapk)(?:\?[^"'\s<>]*)?)["']/gi)) {
    addCandidate(match[1]);
  }

  const unique = [...new Set(candidates)];
  if (!unique.length) return null;

  // Prefer universal builds when a page exposes multiple architectures.
  return unique.sort((a, b) => {
    const au = /universal/i.test(a), bu = /universal/i.test(b);
    return Number(bu) - Number(au);
  })[0];
}

async function fetchResolverPage(url, config) {
  let current = new URL(url);

  for (let hop = 0; hop <= APP_MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json",
        "user-agent": "MahiFlix-App-Download-Resolver/1.0"
      },
      signal: AbortSignal.timeout(APP_RESOLVER_TIMEOUT_MS)
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) throw new Error("Resolver redirect without location.");

    const next = normalizeHref(location, current);
    if (!next || next.protocol !== "https:") {
      throw new Error("Resolver redirect rejected.");
    }

    const resolverHosts = config.githubLatest ? ["api.github.com"] : config.allowedHosts;
    if (!resolverHosts.includes(next.hostname)) {
      throw new Error("Resolver redirect host rejected: " + next.hostname);
    }

    current = next;
  }

  throw new Error("Too many resolver redirects.");
}

function resolveLatestAppDownload(id) {
  const config = APP_DOWNLOADS[id];
  if (!config) return Promise.resolve(null);

  const cached = appDownloadCache.get(id);
  if (cached && Date.now() - cached.checkedAt < (cached.url ? APP_DOWNLOAD_CACHE_MS : APP_NEGATIVE_CACHE_MS)) {
    return Promise.resolve(cached.url);
  }

  // Many people tapping the same app at once share one upstream lookup.
  if (!appDownloadInflight.has(id)) {
    appDownloadInflight.set(id, resolveLatestAppDownloadUncached(id).finally(() => appDownloadInflight.delete(id)));
  }
  return appDownloadInflight.get(id);
}

async function resolveLatestAppDownloadUncached(id) {
  const config = APP_DOWNLOADS[id];

  try {
    if (config.githubLatest) {
      const response = await fetch(config.page, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "MahiFlix-App-Download-Resolver/1.0"
        },
        signal: AbortSignal.timeout(APP_RESOLVER_TIMEOUT_MS)
      });

      if (response.ok) {
        const release = await response.json();
        const asset = Array.isArray(release.assets)
          ? release.assets.find((item) =>
              item &&
              item.browser_download_url &&
              config.assetPattern.test(String(item.name || "")) &&
              allowedDownloadUrl(new URL(item.browser_download_url), config)
            )
          : null;

        if (asset?.browser_download_url) {
          appDownloadCache.set(id, {
            checkedAt: Date.now(),
            url: asset.browser_download_url
          });
          return asset.browser_download_url;
        }
      }
    } else {
      const response = await fetchResolverPage(config.page, config);

      if (response.ok) {
        const html = await response.text();
        const latest = extractLatestApk(html, config, response.url || config.page);

        if (latest) {
          appDownloadCache.set(id, {
            checkedAt: Date.now(),
            url: latest
          });
          return latest;
        }
      }
    }
  } catch (error) {
    console.warn("App download resolver fallback:", id, error.message);
  }

  if (config.fallback && !config.githubLatest) {
    try {
      const fallbackUrl = new URL(config.fallback);
      if (fallbackUrl.protocol === "https:" && allowedDownloadUrl(fallbackUrl, config)) {
        appDownloadCache.set(id, {
          checkedAt: Date.now(),
          url: fallbackUrl.toString()
        });
        return fallbackUrl.toString();
      }
    } catch {}
  }

  appDownloadCache.set(id, { checkedAt: Date.now(), url: null });
  return null;
}

async function fetchApk(url, config) {
  let current = new URL(url);

  for (let hop = 0; hop <= APP_MAX_REDIRECTS; hop++) {
    if (!allowedDownloadUrl(current, config)) {
      throw new Error("APK host or path rejected.");
    }

    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": "MahiFlix-App-Downloader/1.0",
        accept: "application/vnd.android.package-archive,application/octet-stream,*/*"
      },
      signal: AbortSignal.timeout(APP_DOWNLOAD_TIMEOUT_MS)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("APK redirect without location.");

      const next = normalizeHref(location, current);
      if (!next || !allowedDownloadUrl(next, config)) {
        throw new Error("APK redirect host/path rejected.");
      }

      current = next;
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error("Upstream APK request failed with HTTP " + response.status);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const contentDisposition = response.headers.get("content-disposition") || "";
    const looksLikeApk =
      /application\/vnd\.android\.package-archive/i.test(contentType) ||
      /\.apk(?:["';]|$)/i.test(contentDisposition) ||
      /\.apk$/i.test(current.pathname);

    if (!looksLikeApk || /text\/(?:html|plain)/i.test(contentType)) {
      await response.body.cancel().catch(() => {});
      throw new Error("Upstream response is not an APK.");
    }

    return { response, finalUrl: current };
  }

  throw new Error("Too many APK redirects.");
}

function safeApkFilename(url, id, contentDisposition) {
  const dispositionMatch = contentDisposition?.match(/filename\*?=(?:UTF-8''|["']?)([^;"']+)/i);
  const fromHeader = dispositionMatch?.[1] ? decodeURIComponent(dispositionMatch[1]).trim() : "";
  const fromUrl = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
  const raw = /\.apk$/i.test(fromHeader) ? fromHeader : fromUrl;
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return /\.apk$/i.test(cleaned) ? cleaned : "MahiFlix-" + id + ".apk";
}

function errorPage(res, status, title, message, backHref = "/") {
  res.status(status).setHeader("Cache-Control", "no-store").type("html").send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + title + " · MahiFlix</title><style>" +
    "html,body{height:100%;margin:0;background:#0d0d0e;color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif}" +
    "body{display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box}" +
    "img{width:84px;height:84px;filter:drop-shadow(0 0 28px rgba(229,9,20,.45));margin-bottom:18px}" +
    "h1{margin:0 0 8px;font-size:22px}p{margin:0 auto 22px;max-width:420px;color:#a7a7a7;line-height:1.5}" +
    "a{display:inline-block;background:#fff;color:#000;font-weight:800;padding:12px 24px;border-radius:6px;text-decoration:none}" +
    "</style></head><body><main><img src=\"/m-logo-v2.svg\" alt=\"\"><h1>" + title + "</h1><p>" + message +
    '</p><a href="' + backHref + '">Back to MahiFlix</a></main></body></html>'
  );
}

app.get("/download/app/:id", async (req, res) => {
  const id = String(req.params.id || "").toLowerCase();
  const config = APP_DOWNLOADS[id];

  if (!config) {
    return errorPage(res, 404, "App not found", "We couldn't find that app download.");
  }

  try {
    const target = await resolveLatestAppDownload(id);

    if (!target) {
      return errorPage(res, 502, "Download unavailable", "No verified APK is available for this app right now. Please try again in a minute.");
    }

    // Return the verified upstream APK URL directly. This avoids proxy-streaming
    // large APK files through the MahiFlix server and makes the browser handle
    // the download from the source host.
    if (!/^https:\/\//i.test(target)) {
      throw new Error("Resolved APK URL must use HTTPS.");
    }

    res.status(302);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", target);
    return res.end();
  } catch (error) {
    console.error("APK download failed:", id, error.message);
    if (!res.headersSent) {
      errorPage(res, 502, "Download unavailable", "We couldn't reach the download source. Please try again shortly.");
    } else {
      res.destroy(error);
    }
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "MahiFlix",
    tmdbConfigured: hasTmdbCredentials()
  });
});

// Missing files (anything with an extension) get a real 404 so image fallbacks work; everything else is the app shell.
app.get("*", (req, res) => {
  if (path.extname(req.path)) return res.status(404).send("Not found.");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("MahiFlix server running on http://0.0.0.0:" + PORT);
});

// TMDB credentials are intentionally server-side only.
// Preferred: TMDB_READ_TOKEN
// Fallback:  TMDB_API_KEY