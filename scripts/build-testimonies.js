// Reads content/testimonies/*.md (written by Decap CMS) and renders them into
// the testimony grid on testimonies.html, between the markers:
//
//   <!-- TESTIMONIES:START -->  ...generated...  <!-- TESTIMONIES:END -->
//
// Runs on every deploy alongside build-blog.js (see package.json "build").
// Idempotent — it replaces whatever is currently between the markers, so it is
// safe to run locally and again on Vercel.
//
// Same approach as build-blog.js: plain Node + gray-matter, no framework.

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

const ROOT = path.join(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "content", "testimonies");
const PAGE = path.join(ROOT, "testimonies.html");

const START = "<!-- TESTIMONIES:START -->";
const END = "<!-- TESTIMONIES:END -->";

if (!fs.existsSync(PAGE)) {
  console.error("testimonies.html not found — skipping.");
  process.exit(0);
}

let html = fs.readFileSync(PAGE, "utf8");

if (!html.includes(START) || !html.includes(END)) {
  console.warn(
    "testimonies.html has no TESTIMONIES:START/END markers — page left untouched.\n" +
    "  (Run `node scripts/extract-testimonies.js` once to migrate the old hardcoded grid.)"
  );
  process.exit(0);
}

const files = fs.existsSync(CONTENT_DIR)
  ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"))
  : [];

// escape anything coming out of the CMS before it goes into HTML
const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// straight quotes -> curly, and double-dash -> em dash, so CMS-typed text
// matches the typography of the rest of the site
const typo = (s = "") =>
  esc(s)
    .replace(/--/g, "&mdash;")
    .replace(/(^|[\s(])'/g, "$1&lsquo;")
    .replace(/'/g, "&rsquo;");

const testimonies = files
  .map((file) => {
    const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
    const { data, content } = matter(raw);
    return {
      slug: file.replace(/\.md$/, ""),
      name: (data.name || "").trim(),
      date: data.date ? new Date(data.date) : new Date(0),
      image: (data.image || "").trim(),
      alt: (data.alt || "").trim(),
      body: (content || "").trim().replace(/\s*\n\s*/g, " "),
    };
  })
  .filter((t) => t.body || t.image)
  .sort((a, b) => b.date - a.date);

const cards = testimonies
  .map((t) => {
    const altText = esc(t.alt || (t.name ? `Testimony from ${t.name}` : "Testimony shared with the fellowship"));
    const img = t.image
      ? `\n        <img src="${esc(t.image)}" alt="${altText}" loading="lazy">`
      : "";
    const who = t.name
      ? `\n        <div class="who">&mdash; ${typo(t.name)}</div>`
      : "";
    const cap = t.body
      ? `\n        <div class="cap">&ldquo;${typo(t.body)}&rdquo;</div>`
      : "";
    return `      <div class="testimony-card">${img}${cap}${who}\n      </div>`;
  })
  .join("\n");

const generated = cards || `      <p class="lede">New testimonies will appear here as they are shared.</p>`;

const block = `${START}\n${generated}\n      ${END}`;
const between = new RegExp(`${START}[\\s\\S]*?${END}`);

html = html.replace(between, block);
fs.writeFileSync(PAGE, html);

console.log(`Built ${testimonies.length} testimon${testimonies.length === 1 ? "y" : "ies"} into testimonies.html.`);
