const fs = require("fs");
const path = require("path");

const ID = "G-C3ZWMRBX5B";
const SKIP = new Set(["admin", "api", "node_modules", ".git", "images", "scripts", "content"]);

const SNIPPET = `  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${ID}');
  </script>
`;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(full);
    } else if (entry.name.endsWith(".html")) {
      process(full);
    }
  }
}

function process(file) {
  const html = fs.readFileSync(file, "utf8");
  if (html.includes(ID)) return console.log("already has tag:", file);
  if (!html.includes("</head>")) return console.log("NO </head>, skipped:", file);
  fs.writeFileSync(file, html.replace("</head>", SNIPPET + "</head>"));
  console.log("added:", file);
}

walk(process.cwd());