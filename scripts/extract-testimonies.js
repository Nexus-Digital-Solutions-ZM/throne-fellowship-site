// ONE-TIME MIGRATION — run once, then this file can be deleted.
//
//   node scripts/extract-testimonies.js
//
// What it does:
//   1. Reads the current (hardcoded) testimonies.html
//   2. Pulls out every .testimony-card — its image and its caption
//   3. Writes each one as a markdown entry in content/testimonies/
//      (so it shows up in the Decap CMS "Testimonies" collection and can be
//       edited/removed by the Fellowship's admins from now on)
//   4. Saves the inline base64 images out as real .jpg files in images/uploads/
//      (this cuts testimonies.html from ~240KB of base64 down to a few KB,
//       and lets the browser cache the images properly)
//   5. Rewrites testimonies.html with TESTIMONIES:START / END markers, which
//      scripts/build-testimonies.js fills on every build
//
// Safe to re-run: it overwrites its own output and skips cards it already did.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PAGE = path.join(ROOT, "testimonies.html");
const CONTENT_DIR = path.join(ROOT, "content", "testimonies");
const IMG_DIR = path.join(ROOT, "images", "uploads");

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.mkdirSync(IMG_DIR, { recursive: true });

let html = fs.readFileSync(PAGE, "utf8");

if (html.includes("TESTIMONIES:START")) {
  console.log("testimonies.html already migrated — nothing to do.");
  process.exit(0);
}

// ---- 1. grab the cards ----
const cardRe = /<div class="testimony-card">([\s\S]*?)<\/div>\s*<\/div>/g;
const cards = [];
let m;
while ((m = cardRe.exec(html)) !== null) cards.push(m[1]);

if (!cards.length) {
  console.error("No .testimony-card blocks found — aborting, page left untouched.");
  process.exit(1);
}

// ---- 2. decode entities back to plain text for the markdown body ----
const decode = (s) =>
  s
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "\u2014")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim()
    .replace(/^"|"$/g, "")
    .trim();

const pad = (n) => String(n).padStart(2, "0");

cards.forEach((card, i) => {
  const imgMatch = card.match(/<img\s+src="([^"]+)"(?:\s+alt="([^"]*)")?/);
  const capMatch = card.match(/<div class="cap">([\s\S]*?)<\/div>/);

  const caption = capMatch ? decode(capMatch[1]) : "";
  const alt = imgMatch && imgMatch[2] ? decode(imgMatch[2]) : "";
  const slug = `testimony-${pad(i + 1)}`;

  // save the image out of the data URI, if there is one
  let imagePath = "";
  if (imgMatch) {
    const src = imgMatch[1];
    const dataMatch = src.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
    if (dataMatch) {
      const ext = dataMatch[1] === "jpeg" ? "jpg" : dataMatch[1];
      const file = `${slug}.${ext}`;
      fs.writeFileSync(path.join(IMG_DIR, file), Buffer.from(dataMatch[2], "base64"));
      imagePath = `/images/uploads/${file}`;
    } else {
      imagePath = src; // already a normal path — keep as-is
    }
  }

  // ordering: keep the current on-page order. Dates are backdated a day apart
  // so the newest-first sort in the build script preserves it.
  const d = new Date(2026, 8, 1);
  d.setDate(d.getDate() - i);
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00:00.000Z`;

  const fm = [
    "---",
    'name: ""',
    `date: ${dateStr}`,
    `image: "${imagePath}"`,
    `alt: "${alt.replace(/"/g, "'")}"`,
    "---",
    "",
    caption,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(CONTENT_DIR, `${slug}.md`), fm);
  console.log(`  wrote content/testimonies/${slug}.md${imagePath ? ` (+ ${path.basename(imagePath)})` : ""}`);
});

// ---- 3. replace the hardcoded grid with build markers ----
const gridRe = /<div class="testimony-grid">[\s\S]*?<\/div>\s*<\/div>\s*<\/section>/;
const replacement = `<div class="testimony-grid">
      <!-- TESTIMONIES:START -->
      <!-- TESTIMONIES:END -->
    </div>
  </div>
</section>`;

if (!gridRe.test(html)) {
  console.error("Could not locate .testimony-grid — markdown written, but page NOT rewritten.");
  process.exit(1);
}

html = html.replace(gridRe, replacement);
fs.writeFileSync(PAGE, html);

console.log(`\nMigrated ${cards.length} testimonies. Now run: npm run build`);
