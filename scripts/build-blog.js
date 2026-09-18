// Reads content/blog/*.md (written by Decap CMS) and generates:
//   /blog/index.html            - full listing
//   /blog/posts/<slug>.html     - one static page per post
//   /blog/latest.json           - feed the landing page's "Latest Updates" block reads
//
// Run automatically on every deploy (see netlify.toml). No framework —
// plain Node + two small libraries (gray-matter, marked) for parsing.

const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");
const { marked } = require("marked");

const CONTENT_DIR = path.join(__dirname, "..", "content", "blog");
const BLOG_DIR = path.join(__dirname, "..", "blog");
const POSTS_DIR = path.join(BLOG_DIR, "posts");

fs.mkdirSync(POSTS_DIR, { recursive: true });

const files = fs.existsSync(CONTENT_DIR)
  ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"))
  : [];

const posts = files.map((file) => {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
  const { data, content } = matter(raw);
  const slug = file.replace(/\.md$/, "");
  return {
    slug,
    title: data.title || "Untitled",
    date: data.date ? new Date(data.date) : new Date(0),
    excerpt: data.excerpt || "",
    image: data.image || "",
    html: marked.parse(content || ""),
  };
}).sort((a, b) => b.date - a.date);

const fmtDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const PAGE_HEAD = (title) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Throne of Families and Nations Fellowship</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Source+Sans+3:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/blog/blog.css">
</head>
<body>
<header class="blog-header">
  <a href="/index.html" class="brand">&larr; Throne of Families &amp; Nations</a>
</header>
`;
const PAGE_FOOT = `
<footer class="blog-footer">
  &copy; 2026 Throne of Families and Nations Fellowship &mdash; Lusaka, Zambia. All rights reserved.<br>
  Built and maintained by <a href="https://nexus-digital-solution.vercel.app" target="_blank" rel="noopener">Nexus Digital Solutions</a>
</footer>
</body>
</html>
`;

// ---- listing page ----
const listingCards = posts.map((p) => `
  <a class="post-card" href="/blog/posts/${p.slug}.html">
    <div class="post-date">${fmtDate(p.date)}</div>
    <h2>${p.title}</h2>
    <p>${p.excerpt}</p>
    <span class="read-more">Read more &rarr;</span>
  </a>`).join("\n");

const listingHtml = `${PAGE_HEAD("Blog")}
<main class="wrap">
  <h1>Blog</h1>
  <p class="lede">News, updates, and reflections from our fellowship.</p>
  <div class="post-grid">
    ${listingCards || '<p>No posts yet — check back soon.</p>'}
  </div>
</main>
${PAGE_FOOT}`;

fs.writeFileSync(path.join(BLOG_DIR, "index.html"), listingHtml);

// ---- individual post pages ----
posts.forEach((p) => {
  const postHtml = `${PAGE_HEAD(p.title)}
<main class="wrap post-page">
  <a class="back-link" href="/blog/index.html">&larr; Back to Blog</a>
  <div class="post-date">${fmtDate(p.date)}</div>
  <h1>${p.title}</h1>
  <article class="post-body">${p.html}</article>
</main>
${PAGE_FOOT}`;
  fs.writeFileSync(path.join(POSTS_DIR, `${p.slug}.html`), postHtml);
});

// ---- latest.json for the landing page preview block ----
const latest = posts.slice(0, 3).map((p) => ({
  slug: p.slug, title: p.title, date: fmtDate(p.date), excerpt: p.excerpt,
}));
fs.writeFileSync(path.join(BLOG_DIR, "latest.json"), JSON.stringify(latest, null, 2));

console.log(`Built ${posts.length} post(s).`);
