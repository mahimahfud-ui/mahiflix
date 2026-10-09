import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const root = process.cwd();
const indexPath = path.join(root, "index.html");
// Written next to index.html because that is the folder server.js serves.
const outDir = path.join(root, "assets", "logos");
const manifestPath = path.join(root, "logo-manifest.js");

const html = await fs.readFile(indexPath, "utf8");
await fs.mkdir(outDir, { recursive: true });

const entries = [];
const re = /\{name:"([^"]+)"[\s\S]*?domain:"([^"]+)"[\s\S]*?logoSources:\[([^\]]*)\]\}/g;
let match;
while ((match = re.exec(html))) {
  const urls = [...match[3].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(Boolean);
  entries.push({ name: match[1], domain: match[2], urls });
}

const timeoutMs = 8000;
// Keep the committed logos for any site whose live logo can't be fetched at build time.
let manifest = {};
try {
  const prev = await fs.readFile(manifestPath, "utf8");
  manifest = JSON.parse(prev.slice(prev.indexOf("{"), prev.lastIndexOf("}") + 1));
} catch {}

function extFor(type, url) {
  const t = (type || "").split(";")[0].toLowerCase();
  if (t.includes("svg")) return "svg";
  if (t.includes("webp")) return "webp";
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("gif")) return "gif";
  if (t.includes("x-icon") || t.includes("ico")) return "ico";
  const cleanUrl = url.split("?")[0];
  const ext = path.extname(new URL(cleanUrl).pathname).replace(".", "").toLowerCase();
  return ["svg","webp","png","jpg","jpeg","gif","ico"].includes(ext) ? ext : "png";
}

async function fetchOne(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "MahiFlix Logo Builder/1.0" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const type = res.headers.get("content-type") || "";
    if (!/^image\//i.test(type) && !/svg/i.test(type)) throw new Error("Not an image");
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) throw new Error("Invalid image size");
    return { buf, type };
  } finally {
    clearTimeout(timer);
  }
}

for (const entry of entries) {
  let saved = false;
  for (const url of entry.urls) {
    try {
      const { buf, type } = await fetchOne(url);
      const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
      const ext = extFor(type, url);
      const filename = entry.domain.replace(/[^a-z0-9.-]/gi, "_") + "-" + hash + "." + ext;
      await fs.writeFile(path.join(outDir, filename), buf);
      manifest[entry.domain] = "/assets/logos/" + filename;
      saved = true;
      console.log("[logo] " + entry.name + " -> " + manifest[entry.domain]);
      break;
    } catch (err) {
      console.warn("[logo] failed " + entry.name + " source " + url + ": " + err.message);
    }
  }
  if (!saved) console.warn("[logo] no local source succeeded for " + entry.name);
}

const js = "window.MAHIFLIX_LOGOS=" + JSON.stringify(manifest, null, 2) + ";\n";
await fs.mkdir(path.dirname(manifestPath), { recursive: true });
await fs.writeFile(manifestPath, js, "utf8");
console.log("[logo] generated " + Object.keys(manifest).length + "/" + entries.length + " local logos");
