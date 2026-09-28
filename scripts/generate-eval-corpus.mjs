#!/usr/bin/env node
/**
 * Regenerate tests/eval/fixtures/corpus.json — the labeled Jev evaluation
 * corpus (spec FR1, plan Phase 6 Task 1).
 *
 * Everything here is synthetic: curated public-web titles/URLs written for
 * this fixture, no real user exports, no credentials, no notes. Sensitive-
 * site and malformed fixtures are marked `excluded: true` (the corpus schema
 * enforces the flag equals the pipeline's own isSensitiveUrl verdict).
 *
 * Usage: node scripts/generate-eval-corpus.mjs
 * Verify: npx vitest run tests/unit/eval-schema.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "tests", "eval", "fixtures", "corpus.json");

const B = (id, title, url, meta = {}) => ({ id, title, url, ...meta });

// Folder ids mirror the placement/misfiled candidate contract: `id` is the
// option key, `path` is root-first display segments.
const FOLDERS = {
  f_dev: ["Bookmarks bar", "Dev"],
  f_dev_js: ["Bookmarks bar", "Dev", "JavaScript"],
  f_dev_rust: ["Bookmarks bar", "Dev", "Rust"],
  f_dev_python: ["Bookmarks bar", "Dev", "Python"],
  f_news: ["Bookmarks bar", "News"],
  f_media: ["Bookmarks bar", "Media"],
  f_read: ["Bookmarks bar", "Read later"],
  f_shop: ["Bookmarks bar", "Shopping"],
  f_social: ["Bookmarks bar", "Social"],
  f_recipes: ["Bookmarks bar", "Recipes"],
  f_travel: ["Bookmarks bar", "Travel"],
  f_ref: ["Other bookmarks", "Reference"],
  f_archive: ["Other bookmarks", "Archive"],
  f_random: ["Other bookmarks", "Random"],
};

const TAGS = {
  rust: { name: "rust", nameKey: "rust", description: "Rust programming language" },
  javascript: { name: "javascript", nameKey: "javascript", description: "JavaScript and TypeScript" },
  python: { name: "python", nameKey: "python", description: "Python programming language" },
  devtools: { name: "devtools", nameKey: "devtools", description: "Developer tools and workflows" },
  tutorial: { name: "tutorial", nameKey: "tutorial", description: "Step-by-step instructional content" },
  news: { name: "news", nameKey: "news", description: "Current events and journalism" },
  video: { name: "video", nameKey: "video", description: "Video content" },
  cooking: { name: "cooking", nameKey: "cooking", description: "Recipes and food preparation" },
  travel: { name: "travel", nameKey: "travel", description: "Destinations and trip planning" },
  finance: { name: "finance", nameKey: "finance", description: "Money, markets, and investing" },
  ml: { name: "ml", nameKey: "ml", description: "Machine learning and AI" },
  music: { name: "music", nameKey: "music", description: "Music and audio" },
  gaming: { name: "gaming", nameKey: "gaming", description: "Video games" },
  research: { name: "research", nameKey: "research", description: "Papers and primary sources" },
  reference: { name: "reference", nameKey: "reference", description: "Lookup material" },
  funny: { name: "funny", nameKey: "funny", description: "Humor" },
  career: { name: "career", nameKey: "career", description: "Jobs and professional growth" },
  selfhost: { name: "selfhost", nameKey: "selfhost", description: "Self-hosted software" },
};

// ---------------------------------------------------------------------------
// Bookmarks. `cat`/`folder`/`tags` are authoring labels consumed by the case
// generators below — they never land in the emitted JSON.
// ---------------------------------------------------------------------------
const BOOKMARKS = [
  // --- docs (40) ---
  B("docs_mdn_fetch", "Using the Fetch API - MDN", "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_mdn_array", "Array - JavaScript - MDN", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_python_urllib", "urllib.request — Python 3.13 docs", "https://docs.python.org/3/library/urllib.request.html", { cat: "docs", folder: "f_dev_python", tags: ["python", "reference"] }),
  B("docs_python_asyncio", "asyncio — Asynchronous I/O", "https://docs.python.org/3/library/asyncio.html", { cat: "docs", folder: "f_dev_python", tags: ["python"] }),
  B("docs_rust_book_ch4", "Understanding Ownership - The Rust Book", "https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html", { cat: "docs", folder: "f_dev_rust", tags: ["rust", "tutorial"] }),
  B("docs_rust_std_vec", "std::vec::Vec - Rust", "https://doc.rust-lang.org/std/vec/struct.Vec.html", { cat: "docs", folder: "f_dev_rust", tags: ["rust", "reference"] }),
  B("docs_rust_by_example", "Rust by Example", "https://doc.rust-lang.org/rust-by-example/", { cat: "docs", folder: "f_dev_rust", tags: ["rust", "tutorial"] }),
  B("docs_tokio_tutorial", "Tutorial: Tokio", "https://tokio.rs/tokio/tutorial", { cat: "docs", folder: "f_dev_rust", tags: ["rust", "tutorial"] }),
  B("docs_react_hooks", "Hooks API Reference – React", "https://react.dev/reference/react/hooks", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_react_thinking", "Thinking in React", "https://react.dev/learn/thinking-in-react", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("docs_node_fs", "File system - Node.js", "https://nodejs.org/api/fs.html", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_vite_config", "Configuring Vite", "https://vite.dev/config/", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("docs_tsconfig", "TSConfig Reference", "https://www.typescriptlang.org/tsconfig/", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_k8s_pods", "Pods - Kubernetes", "https://kubernetes.io/docs/concepts/workloads/pods/", { cat: "docs", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("docs_docker_compose", "Docker Compose overview", "https://docs.docker.com/compose/", { cat: "docs", folder: "f_dev", tags: ["devtools"] }),
  B("docs_git_ref", "git-scm documentation", "https://git-scm.com/docs", { cat: "docs", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("docs_postgres_select", "SELECT - PostgreSQL", "https://www.postgresql.org/docs/current/sql-select.html", { cat: "docs", folder: "f_dev", tags: ["reference"] }),
  B("docs_w3c_html", "HTML Standard", "https://html.spec.whatwg.org/multipage/", { cat: "docs", folder: "f_ref", tags: ["reference"] }),
  B("docs_tc39_ecma262", "ECMAScript Language Specification", "https://tc39.es/ecma262/", { cat: "docs", folder: "f_ref", tags: ["javascript", "reference"] }),
  B("docs_tailwind_flex", "Flexbox - Tailwind CSS", "https://tailwindcss.com/docs/flex", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_playwright_test", "Playwright Test docs", "https://playwright.dev/docs/writing-tests", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("docs_vitest_api", "Vitest API Reference", "https://vitest.dev/api/", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("docs_go_effective", "Effective Go", "https://go.dev/doc/effective_go", { cat: "docs", folder: "f_dev", tags: ["tutorial"] }),
  B("docs_rust_nomicon", "The Rustonomicon", "https://doc.rust-lang.org/nomicon/", { cat: "docs", folder: "f_dev_rust", tags: ["rust"] }),
  B("docs_zod_readme", "Zod documentation", "https://zod.dev/", { cat: "docs", folder: "f_dev_js", tags: ["javascript"] }),
  B("docs_wxt_getstarted", "Get Started - WXT", "https://wxt.dev/get-started.html", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("docs_chrome_mv3", "Chrome Extensions Manifest V3", "https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_dexie_quickstart", "Dexie.js Tutorial", "https://dexie.org/docs/Tutorial/Getting-started", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("docs_mdn_css_grid", "CSS grid layout - MDN", "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout", { cat: "docs", folder: "f_dev_js", tags: ["reference"] }),
  B("docs_aws_s3", "Amazon S3 User Guide", "https://docs.aws.amazon.com/AmazonS3/latest/userguide/", { cat: "docs", folder: "f_dev", tags: ["reference"] }),
  B("docs_protobuf_lang", "Protocol Buffers Language Guide", "https://protobuf.dev/programming-guides/proto3/", { cat: "docs", folder: "f_dev", tags: ["reference"] }),
  B("docs_openapi_spec", "OpenAPI Specification v3.1", "https://spec.openapis.org/oas/v3.1.0", { cat: "docs", folder: "f_ref", tags: ["reference"] }),
  B("docs_regex_mdn", "Regular expressions - MDN", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("docs_sqlite_select", "SQLite SELECT", "https://sqlite.org/lang_select.html", { cat: "docs", folder: "f_dev", tags: ["reference"] }),
  B("docs_systemd_service", "systemd.service man page", "https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html", { cat: "docs", folder: "f_dev", tags: ["reference"] }),
  B("docs_nix_manual", "Nix Reference Manual", "https://nix.dev/manual/nix/latest/", { cat: "docs", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("docs_web_llm_api", "Web Crypto API - MDN", "https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("docs_http_mdn_status", "HTTP response status codes", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status", { cat: "docs", folder: "f_ref", tags: ["reference"] }),
  B("docs_jq_manual", "jq Manual", "https://jqlang.org/manual/", { cat: "docs", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("docs_wasm_mdn", "WebAssembly - MDN", "https://developer.mozilla.org/en-US/docs/WebAssembly", { cat: "docs", folder: "f_dev_js", tags: ["javascript", "reference"] }),

  // --- article (45) ---
  B("art_medium_rust", "Why Rust is taking over systems programming", "https://medium.com/@dev.perspective/why-rust-systems-abc123", { cat: "article", folder: "f_read", tags: ["rust"] }),
  B("art_devto_hooks", "10 React hooks mistakes I made", "https://dev.to/janedoe/react-hooks-mistakes-3k2a", { cat: "article", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("art_bbc_climate", "Climate summit reaches tentative agreement", "https://www.bbc.com/news/science-environment-68001", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("art_nyt_economy", "Central banks signal rate shift", "https://www.nytimes.com/2026/02/10/business/central-banks-rates.html", { cat: "article", folder: "f_news", tags: ["news", "finance"] }),
  B("art_ars_quantum", "Quantum error correction hits new milestone", "https://arstechnica.com/science/2026/03/quantum-error-correction-milestone/", { cat: "article", folder: "f_news", tags: ["news", "research"] }),
  B("art_verge_gadget", "The best mechanical keyboards of 2026", "https://www.theverge.com/2026/1/5/best-mechanical-keyboards", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("art_wired_ai", "Inside the race to build smaller language models", "https://www.wired.com/story/smaller-language-models-race/", { cat: "article", folder: "f_news", tags: ["news", "ml"] }),
  B("art_substack_finance", "A deep dive into index fund fees", "https://letters.example-writer.com/p/index-fund-fees", { cat: "article", folder: "f_read", tags: ["finance"] }),
  B("art_hn_show", "Show HN: A terminal-based Git client written in Go", "https://news.ycombinator.com/item?id=399001", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("art_blog_perf", "How we cut our p99 latency by 80%", "https://engineering.example-shop.com/p99-latency", { cat: "article", folder: "f_read", tags: ["devtools"] }),
  B("art_blog_migration", "Migrating a million bookmarks without downtime", "https://engineering.example-data.com/migration-postmortem", { cat: "article", folder: "f_read", tags: ["devtools"] }),
  B("art_guardian_climate", "Renewables overtake coal in grid mix", "https://www.theguardian.com/environment/2026/apr/12/renewables-coal-grid", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("art_bloomberg_markets", "Markets rally on chip earnings", "https://www.bloomberg.com/news/articles/2026-05-01/markets-chip-rally", { cat: "article", folder: "f_news", tags: ["news", "finance"] }),
  B("art_recipe_bread", "The overnight sourdough method that changed my weekends", "https://www.bakingblog.example.com/overnight-sourdough", { cat: "article", folder: "f_recipes", tags: ["cooking"] }),
  B("art_travel_japan", "Two weeks in Hokkaido: a practical itinerary", "https://travel-journal.example.com/hokkaido-two-weeks", { cat: "article", folder: "f_travel", tags: ["travel"] }),
  B("art_lwn_kernel", "A new approach to kernel scheduling", "https://lwn.net/Articles/990123/", { cat: "article", folder: "f_read", tags: ["research", "devtools"] }),
  B("art_ieee_spectrum", "The chiplet revolution in CPU design", "https://spectrum.ieee.org/chiplet-cpu-design", { cat: "article", folder: "f_news", tags: ["news", "research"] }),
  B("art_apnews_space", "Lunar station module arrives at orbit site", "https://apnews.com/article/lunar-station-module-2026", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("art_atlantic_cities", "The fifteen-minute city debate, explained", "https://www.theatlantic.com/ideas/archive/2026/02/fifteen-minute-city/", { cat: "article", folder: "f_read", tags: ["news"] }),
  B("art_ft_fintech", "Fintech lenders face new capital rules", "https://www.ft.com/content/fintech-capital-rules-2026", { cat: "article", folder: "f_news", tags: ["news", "finance"] }),
  B("art_science_journal", "New battery chemistry doubles cycle life", "https://www.science.org/doi/10.1126/science.battery2026", { cat: "article", folder: "f_read", tags: ["research"] }),
  B("art_devto_css", "Modern CSS you can stop polyfilling", "https://dev.to/css_fan/modern-css-polyfill-free-4b2n", { cat: "article", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("art_medium_design", "Design systems are a governance problem", "https://medium.com/design-notes/design-systems-governance-9f2e", { cat: "article", folder: "f_read", tags: [] }),
  B("art_blog_postgres", "Postgres query plans, demystified", "https://blog.example-db.com/postgres-plans", { cat: "article", folder: "f_dev", tags: ["reference"] }),
  B("art_blog_rust_embedded", "Rust on a $4 microcontroller", "https://embedded.example.com/rust-microcontroller", { cat: "article", folder: "f_dev_rust", tags: ["rust", "tutorial"] }),
  B("art_outdoors_hike", "Hiking the Tour du Mont Blanc alone", "https://trail-notes.example.com/tmb-solo", { cat: "article", folder: "f_travel", tags: ["travel"] }),
  B("art_music_theory", "Why the tritone was banned (and why it wasn't)", "https://music-theory.example.com/tritone-myth", { cat: "article", folder: "f_read", tags: ["music"] }),
  B("art_game_design", "What Hollow Knight teaches about difficulty curves", "https://gamedesign.example.com/hollow-knight-difficulty", { cat: "article", folder: "f_read", tags: ["gaming"] }),
  B("art_health_walking", "What 10,000 steps actually does", "https://health-journal.example.com/ten-thousand-steps", { cat: "article", folder: "f_news", tags: [] }),
  B("art_history_rome", "The concrete recipe Rome took to its grave", "https://history-monthly.example.com/roman-concrete", { cat: "article", folder: "f_read", tags: ["research"] }),
  B("art_devto_python", "Python packaging in 2026, finally sane", "https://dev.to/py_wizard/python-packaging-2026-1a1b", { cat: "article", folder: "f_dev_python", tags: ["python", "tutorial"] }),
  B("art_blog_selfhost", "I replaced five SaaS tools with one VPS", "https://selfhost-journey.example.com/vps-replacement", { cat: "article", folder: "f_read", tags: ["selfhost"] }),
  B("art_tomshardware_gpu", "GPU prices normalize after memory glut", "https://www.tomshardware.com/news/gpu-prices-2026", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("art_recipe_ramen", "A weeknight ramen that isn't instant", "https://homecooking.example.com/weeknight-ramen", { cat: "article", folder: "f_recipes", tags: ["cooking"] }),
  B("art_space_mars", "What the Mars sample return actually found", "https://spacenews.example.com/mars-sample-findings", { cat: "article", folder: "f_news", tags: ["news", "research"] }),
  B("art_crypto_reg", "Stablecoin rules arrive in the EU", "https://cryptobrief.example.com/eu-stablecoin-rules", { cat: "article", folder: "f_news", tags: ["news", "finance"] }),
  B("art_blog_rust_error", "Error handling in Rust without the noise", "https://rust-notes.example.com/error-handling", { cat: "article", folder: "f_dev_rust", tags: ["rust", "tutorial"] }),
  B("art_devto_a11y", "Accessibility wins that take an afternoon", "https://dev.to/a11y_dev/quick-accessibility-wins-2x8k", { cat: "article", folder: "f_dev_js", tags: ["javascript", "tutorial"] }),
  B("art_language_learning", "How spaced repetition actually works", "https://language-notes.example.com/spaced-repetition", { cat: "article", folder: "f_read", tags: ["research"] }),
  B("art_photo_film", "Shooting film in 2026: a field guide", "https://photo-journal.example.com/film-guide", { cat: "article", folder: "f_travel", tags: [] }),
  B("art_econ_remote", "Remote work five years on: the data", "https://econ-review.example.com/remote-work-data", { cat: "article", folder: "f_read", tags: ["career", "research"] }),
  B("art_blog_git", "Git bisect saved my release", "https://devstories.example.com/git-bisect-release", { cat: "article", folder: "f_dev", tags: ["devtools", "tutorial"] }),
  B("art_medium_privacy", "What 'privacy-first' actually requires", "https://medium.com/privacy-lab/what-privacy-first-requires-a81c", { cat: "article", folder: "f_read", tags: ["research"] }),
  B("art_cycling_alps", "Climbing the Stelvio on a steel frame", "https://cycling-log.example.com/stelvio", { cat: "article", folder: "f_travel", tags: ["travel"] }),
  B("art_ai_regulation", "How model evals became a compliance topic", "https://policy-brief.example.com/model-evals-compliance", { cat: "article", folder: "f_news", tags: ["news", "ml"] }),

  // --- tool (30) ---
  B("tool_figma", "Figma – the collaborative design tool", "https://www.figma.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_excalidraw", "Excalidraw – hand-drawn diagrams", "https://excalidraw.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_regex101", "regex101: regex tester", "https://regex101.com/", { cat: "tool", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("tool_caniuse", "Can I use... browser support tables", "https://caniuse.com/", { cat: "tool", folder: "f_dev", tags: ["javascript", "reference"] }),
  B("tool_jwtio", "JWT.IO – decode tokens", "https://jwt.io/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_codesandbox", "CodeSandbox – online IDE", "https://codesandbox.io/", { cat: "tool", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("tool_jsonlint", "JSONLint validator", "https://jsonlint.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_speedtest", "Speedtest by Ookla", "https://www.speedtest.net/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_crontab", "crontab.guru – cron schedule editor", "https://crontab.guru/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_bundlephobia", "Bundlephobia – package size cost", "https://bundlephobia.com/", { cat: "tool", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("tool_mermaid", "Mermaid Live Editor", "https://mermaid.live/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_tldraw", "tldraw whiteboard", "https://www.tldraw.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_overleaf", "Overleaf – online LaTeX", "https://www.overleaf.com/", { cat: "tool", folder: "f_ref", tags: ["research"] }),
  B("tool_translate", "DeepL Translator", "https://www.deepl.com/translator", { cat: "tool", folder: "f_random", tags: ["reference"] }),
  B("tool_carbon", "Carbon – code screenshots", "https://carbon.now.sh/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_diff", "Diffchecker – compare text", "https://www.diffchecker.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_timezone", "Time.is – exact time", "https://time.is/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_webcheck", "Web Check – site analyzer", "https://web-check.xyz/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_svgomg", "SVGOMG – SVG optimizer", "https://jakearchibald.github.io/svgomg/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_jsonpath", "JSONPath evaluator", "https://jsonpath.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_colorhunt", "Color Hunt palettes", "https://colorhunt.co/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_photopea", "Photopea – online photo editor", "https://www.photopea.com/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_itertools", "itty.bitty.site – self-contained pages", "https://itty.bitty.site/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_stackblitz", "StackBlitz – instant dev environments", "https://stackblitz.com/", { cat: "tool", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("tool_postman_echo", "Postman Echo – HTTP test", "https://postman-echo.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_cron_translate", "Cron schedule translator", "https://cronkit.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_exif", "EXIF data viewer", "https://exif.tools/", { cat: "tool", folder: "f_random", tags: [] }),
  B("tool_pingdom", "Pingdom Tools", "https://tools.pingdom.com/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_drawio", "diagrams.net (draw.io)", "https://app.diagrams.net/", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("tool_mathway", "Mathway solver", "https://www.mathway.com/", { cat: "tool", folder: "f_random", tags: ["reference"] }),

  // --- video (30) ---
  B("vid_yt_rustconf", "RustConf 2025 keynote", "https://www.youtube.com/watch?v=rustconf25", { cat: "video", folder: "f_media", tags: ["rust", "video"] }),
  B("vid_yt_fireship", "Fireship channel", "https://www.youtube.com/@Fireship", { cat: "video", folder: "f_media", tags: ["video", "devtools"] }),
  B("vid_yt_primagen", "ThePrimeagen channel", "https://www.youtube.com/@ThePrimeagen", { cat: "video", folder: "f_media", tags: ["video", "devtools"] }),
  B("vid_ted_talk", "TED: How great leaders inspire action", "https://www.ted.com/talks/simon_sinek_how_great_leaders_inspire_action", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_vimeo_doc", "Documentary short: tidal energy", "https://vimeo.com/tidal-energy-doc", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_cooking", "Binging with Babish: ratatouille", "https://www.youtube.com/watch?v=babish-ratatouille", { cat: "video", folder: "f_media", tags: ["video", "cooking"] }),
  B("vid_yt_gaming", "Speedrun world record commentary", "https://www.youtube.com/watch?v=wr-commentary-42", { cat: "video", folder: "f_media", tags: ["video", "gaming"] }),
  B("vid_twitch_stream", "Live rust hacking stream", "https://www.twitch.tv/rustacean_dev", { cat: "video", folder: "f_media", tags: ["video", "rust"] }),
  B("vid_yt_lecture", "MIT 6.824 distributed systems lecture 1", "https://www.youtube.com/watch?v=mit-6824-lec1", { cat: "video", folder: "f_media", tags: ["video", "tutorial", "research"] }),
  B("vid_yt_music", "Lo-fi study beats live", "https://www.youtube.com/watch?v=lofi-study-24h", { cat: "video", folder: "f_media", tags: ["video", "music"] }),
  B("vid_yt_math", "3Blue1Brown: linear algebra essence", "https://www.youtube.com/watch?v=3b1b-linear-algebra", { cat: "video", folder: "f_media", tags: ["video", "tutorial"] }),
  B("vid_yt_history", "History of the transcontinental railroad", "https://www.youtube.com/watch?v=railroad-history-doc", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_space", "Rocket launch replay", "https://www.youtube.com/watch?v=rocket-launch-replay", { cat: "video", folder: "f_media", tags: ["video", "news"] }),
  B("vid_yt_travel", "Japan by train in 4K", "https://www.youtube.com/watch?v=japan-train-4k", { cat: "video", folder: "f_media", tags: ["video", "travel"] }),
  B("vid_yt_diy", "Building a workbench from reclaimed wood", "https://www.youtube.com/watch?v=workbench-diy", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_compilers", "How a compiler works, visually", "https://www.youtube.com/watch?v=compiler-visual", { cat: "video", folder: "f_media", tags: ["video", "tutorial", "devtools"] }),
  B("vid_yt_f1", "F1 qualifying highlights", "https://www.youtube.com/watch?v=f1-quali-2026", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_guitar", "Learn fingerstyle in 30 days", "https://www.youtube.com/watch?v=fingerstyle-30", { cat: "video", folder: "f_media", tags: ["video", "music", "tutorial"] }),
  B("vid_yt_climbing", "Free solo documentary", "https://www.youtube.com/watch?v=free-solo-doc", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_crypto", "How zero-knowledge proofs work", "https://www.youtube.com/watch?v=zk-proofs-explained", { cat: "video", folder: "f_media", tags: ["video", "tutorial", "research"] }),
  B("vid_yt_news_daily", "Daily news digest show", "https://www.youtube.com/watch?v=daily-news-digest", { cat: "video", folder: "f_media", tags: ["video", "news"] }),
  B("vid_coursera_ml", "Machine learning specialization week 3", "https://www.coursera.org/learn/machine-learning/lecture/week3", { cat: "video", folder: "f_media", tags: ["video", "ml", "tutorial"] }),
  B("vid_yt_webdev", "Building a browser engine from scratch", "https://www.youtube.com/watch?v=browser-engine-scratch", { cat: "video", folder: "f_media", tags: ["video", "devtools"] }),
  B("vid_yt_bread", "Perfect baguettes at home", "https://www.youtube.com/watch?v=baguettes-home", { cat: "video", folder: "f_media", tags: ["video", "cooking"] }),
  B("vid_yt_photo", "Film photography darkroom basics", "https://www.youtube.com/watch?v=darkroom-basics", { cat: "video", folder: "f_media", tags: ["video", "tutorial"] }),
  B("vid_yt_fitness", "20-minute mobility routine", "https://www.youtube.com/watch?v=mobility-20min", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("vid_yt_podcast", "Software engineering daily ep. 900", "https://www.youtube.com/watch?v=se-daily-900", { cat: "video", folder: "f_media", tags: ["video", "devtools"] }),
  B("vid_yt_birds", "Backyard bird identification guide", "https://www.youtube.com/watch?v=bird-id-guide", { cat: "video", folder: "f_media", tags: ["video", "reference"] }),
  B("vid_yt_rust_live", "Async Rust deep dive", "https://www.youtube.com/watch?v=async-rust-deep", { cat: "video", folder: "f_media", tags: ["video", "rust"] }),
  B("vid_yt_chess", "Grandmaster game analysis", "https://www.youtube.com/watch?v=gm-analysis", { cat: "video", folder: "f_media", tags: ["video", "gaming"] }),

  // --- repo (35) ---
  B("repo_typescript", "microsoft/TypeScript", "https://github.com/microsoft/TypeScript", { cat: "repo", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("repo_rust", "rust-lang/rust", "https://github.com/rust-lang/rust", { cat: "repo", folder: "f_dev_rust", tags: ["rust"] }),
  B("repo_tokio", "tokio-rs/tokio", "https://github.com/tokio-rs/tokio", { cat: "repo", folder: "f_dev_rust", tags: ["rust"] }),
  B("repo_react", "facebook/react", "https://github.com/facebook/react", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_vitest", "vitest-dev/vitest", "https://github.com/vitest-dev/vitest", { cat: "repo", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("repo_wxt", "wxt-dev/wxt", "https://github.com/wxt-dev/wxt", { cat: "repo", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("repo_zod", "colinhacks/zod", "https://github.com/colinhacks/zod", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_dexie", "dexie/Dexie.js", "https://github.com/dexie/Dexie.js", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_django", "django/django", "https://github.com/django/django", { cat: "repo", folder: "f_dev_python", tags: ["python"] }),
  B("repo_flask", "pallets/flask", "https://github.com/pallets/flask", { cat: "repo", folder: "f_dev_python", tags: ["python"] }),
  B("repo_numpy", "numpy/numpy", "https://github.com/numpy/numpy", { cat: "repo", folder: "f_dev_python", tags: ["python", "research"] }),
  B("repo_pandas", "pandas-dev/pandas", "https://github.com/pandas-dev/pandas", { cat: "repo", folder: "f_dev_python", tags: ["python"] }),
  B("repo_kubernetes", "kubernetes/kubernetes", "https://github.com/kubernetes/kubernetes", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_docker", "docker/compose", "https://github.com/docker/compose", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_neovim", "neovim/neovim", "https://github.com/neovim/neovim", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_npm_react", "react – npm", "https://www.npmjs.com/package/react", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_pypi_requests", "requests – PyPI", "https://pypi.org/project/requests/", { cat: "repo", folder: "f_dev_python", tags: ["python"] }),
  B("repo_crates_serde", "serde – crates.io", "https://crates.io/crates/serde", { cat: "repo", folder: "f_dev_rust", tags: ["rust"] }),
  B("repo_gitlab_runner", "gitlab-runner", "https://gitlab.com/gitlab-org/gitlab-runner", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_homebrew", "Homebrew/brew", "https://github.com/Homebrew/brew", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_tailwind", "tailwindlabs/tailwindcss", "https://github.com/tailwindlabs/tailwindcss", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_playwright", "microsoft/playwright", "https://github.com/microsoft/playwright", { cat: "repo", folder: "f_dev_js", tags: ["javascript", "devtools"] }),
  B("repo_linux", "torvalds/linux", "https://github.com/torvalds/linux", { cat: "repo", folder: "f_dev", tags: ["reference"] }),
  B("repo_awesome_rust", "rust-unofficial/awesome-rust", "https://github.com/rust-unofficial/awesome-rust", { cat: "repo", folder: "f_dev_rust", tags: ["rust", "reference"] }),
  B("repo_awesome_selfhosted", "awesome-selfhosted list", "https://github.com/awesome-selfhosted/awesome-selfhosted", { cat: "repo", folder: "f_dev", tags: ["selfhost", "reference"] }),
  B("repo_vscode", "microsoft/vscode", "https://github.com/microsoft/vscode", { cat: "repo", folder: "f_dev", tags: ["devtools"] }),
  B("repo_alacritty", "alacritty/alacritty", "https://github.com/alacritty/alacritty", { cat: "repo", folder: "f_dev", tags: ["devtools", "rust"] }),
  B("repo_minisearch", "lucaong/minisearch", "https://github.com/lucaong/minisearch", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_radix", "radix-ui/primitives", "https://github.com/radix-ui/primitives", { cat: "repo", folder: "f_dev_js", tags: ["javascript"] }),
  B("repo_go", "golang/go", "https://github.com/golang/go", { cat: "repo", folder: "f_dev", tags: ["reference"] }),
  B("repo_llvm", "llvm/llvm-project", "https://github.com/llvm/llvm-project", { cat: "repo", folder: "f_dev", tags: ["reference"] }),
  B("repo_bitwarden", "bitwarden/clients", "https://github.com/bitwarden/clients", { cat: "repo", folder: "f_dev", tags: ["selfhost"] }),
  B("repo_hugo", "gohugoio/hugo", "https://github.com/gohugoio/hugo", { cat: "repo", folder: "f_dev", tags: ["selfhost"] }),
  B("repo_immich", "immich-app/immich", "https://github.com/immich-app/immich", { cat: "repo", folder: "f_dev", tags: ["selfhost"] }),
  B("repo_nixpkgs", "NixOS/nixpkgs", "https://github.com/NixOS/nixpkgs", { cat: "repo", folder: "f_dev", tags: ["selfhost", "reference"] }),

  // --- reference (30) ---
  B("ref_wiki_rust", "Rust (programming language) - Wikipedia", "https://en.wikipedia.org/wiki/Rust_(programming_language)", { cat: "reference", folder: "f_ref", tags: ["rust", "reference"] }),
  B("ref_wiki_tcp", "Transmission Control Protocol - Wikipedia", "https://en.wikipedia.org/wiki/Transmission_Control_Protocol", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_wiki_japan", "Japan - Wikipedia", "https://en.wikipedia.org/wiki/Japan", { cat: "reference", folder: "f_ref", tags: ["travel", "reference"] }),
  B("ref_so_gitignore", "gitignore for a Node project - Stack Overflow", "https://stackoverflow.com/questions/896698/node-gitignore", { cat: "reference", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("ref_so_async", "How does async await work in JavaScript?", "https://stackoverflow.com/questions/23667086/async-await-javascript", { cat: "reference", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("ref_wiktionary", "serendipity - Wiktionary", "https://en.wiktionary.org/wiki/serendipity", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_imdb_film", "Blade Runner 2049 - IMDb", "https://www.imdb.com/title/tt1856101/", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_investopedia_etf", "Exchange-Traded Fund (ETF) - Investopedia", "https://www.investopedia.com/terms/e/etf.asp", { cat: "reference", folder: "f_ref", tags: ["finance", "reference"] }),
  B("ref_britannica_rome", "Roman Empire - Britannica", "https://www.britannica.com/place/Roman-Empire", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_arxiv_transformer", "Attention Is All You Need - arXiv", "https://arxiv.org/abs/1706.03762", { cat: "reference", folder: "f_ref", tags: ["ml", "research"] }),
  B("ref_arxiv_llm", "Scaling laws for neural language models - arXiv", "https://arxiv.org/abs/2001.08361", { cat: "reference", folder: "f_ref", tags: ["ml", "research"] }),
  B("ref_papers_gfs", "The Google File System", "https://research.google/pubs/the-google-file-system/", { cat: "reference", folder: "f_ref", tags: ["research"] }),
  B("ref_wiki_paxos", "Paxos (computer science) - Wikipedia", "https://en.wikipedia.org/wiki/Paxos_(computer_science)", { cat: "reference", folder: "f_ref", tags: ["research", "reference"] }),
  B("ref_pubmed", "Caffeine effects meta-analysis - PubMed", "https://pubmed.ncbi.nlm.nih.gov/caffeine-meta", { cat: "reference", folder: "f_ref", tags: ["research"] }),
  B("ref_wiki_bird", "Northern cardinal - Wikipedia", "https://en.wikipedia.org/wiki/Northern_cardinal", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_so_rust_lifetime", "Understanding Rust lifetimes", "https://stackoverflow.com/questions/31609137/rust-lifetimes", { cat: "reference", folder: "f_dev_rust", tags: ["rust", "reference"] }),
  B("ref_nist_aes", "FIPS 197: AES - NIST", "https://csrc.nist.gov/publications/detail/fips/197/final", { cat: "reference", folder: "f_ref", tags: ["research", "reference"] }),
  B("ref_rfc_9110", "RFC 9110: HTTP Semantics", "https://www.rfc-editor.org/rfc/rfc9110", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_wiki_chess", "Chess - Wikipedia", "https://en.wikipedia.org/wiki/Chess", { cat: "reference", folder: "f_ref", tags: ["gaming", "reference"] }),
  B("ref_usda_food", "FoodData Central - USDA", "https://fdc.nal.usda.gov/", { cat: "reference", folder: "f_ref", tags: ["cooking", "reference"] }),
  B("ref_wiki_french_rev", "French Revolution - Wikipedia", "https://en.wikipedia.org/wiki/French_Revolution", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_oed_word", "Oxford English Dictionary entry", "https://www.oed.com/dictionary/example-entry", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_so_docker", "How to copy files into a Docker container", "https://stackoverflow.com/questions/22907231/docker-copy", { cat: "reference", folder: "f_dev", tags: ["devtools", "reference"] }),
  B("ref_mdn_glossary", "MDN Web Docs Glossary", "https://developer.mozilla.org/en-US/docs/Glossary", { cat: "reference", folder: "f_ref", tags: ["javascript", "reference"] }),
  B("ref_wiki_distributed", "Distributed computing - Wikipedia", "https://en.wikipedia.org/wiki/Distributed_computing", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_papers_dynamo", "Dynamo: Amazon's Highly Available Key-value Store", "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf", { cat: "reference", folder: "f_ref", tags: ["research"] }),
  B("ref_wiki_lisbon", "Lisbon - Wikipedia", "https://en.wikipedia.org/wiki/Lisbon", { cat: "reference", folder: "f_travel", tags: ["travel", "reference"] }),
  B("ref_nhtsa_recall", "Vehicle recalls - NHTSA", "https://www.nhtsa.gov/recalls", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ref_currency_xe", "Currency converter - Xe", "https://www.xe.com/currencyconverter/", { cat: "tool", folder: "f_ref", tags: ["finance", "reference"] }),
  B("ref_wiki_sourdough", "Sourdough - Wikipedia", "https://en.wikipedia.org/wiki/Sourdough", { cat: "reference", folder: "f_recipes", tags: ["cooking", "reference"] }),

  // --- shopping (25) ---
  B("shop_amazon_keyboard", "Mechanical keyboard 75% - Amazon", "https://www.amazon.com/dp/B0KEYBOARD1", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_amazon_book", "The Rust Programming Language book - Amazon", "https://www.amazon.com/dp/1718500440", { cat: "shopping", folder: "f_shop", tags: ["rust"] }),
  B("shop_ebay_camera", "Vintage film camera - eBay", "https://www.ebay.com/itm/vintage-film-camera-123", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_etsy_print", "Letterpress art print - Etsy", "https://www.etsy.com/listing/letterpress-print-42", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_ikea_desk", "Standing desk frame - IKEA", "https://www.ikea.com/us/en/p/desk-frame-001", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_bestbuy_monitor", "27-inch 4K monitor - Best Buy", "https://www.bestbuy.com/site/monitor-4k-27/6400", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_aliexpress_cable", "USB-C cable 2m - AliExpress", "https://www.aliexpress.com/item/usbc-cable-2m.html", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_newegg_ssd", "2TB NVMe SSD - Newegg", "https://www.newegg.com/p/nvme-2tb-ssd", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_rei_jacket", "Rain jacket - REI", "https://www.rei.com/product/rain-jacket-2001", { cat: "shopping", folder: "f_shop", tags: ["travel"] }),
  B("shop_bandcamp_vinyl", "Ambient album vinyl - Bandcamp", "https://artist-example.bandcamp.com/merch/vinyl", { cat: "shopping", folder: "f_shop", tags: ["music"] }),
  B("shop_thriftbooks", "Used sci-fi paperback - ThriftBooks", "https://www.thriftbooks.com/w/scifi-title/12345", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_walmart_tent", "4-person tent - Walmart", "https://www.walmart.com/ip/tent-4person/99887", { cat: "shopping", folder: "f_shop", tags: ["travel"] }),
  B("shop_target_lamp", "Desk lamp - Target", "https://www.target.com/p/desk-lamp/-/A-50001", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_zappos_shoes", "Trail running shoes - Zappos", "https://www.zappos.com/p/trail-shoe-9", { cat: "shopping", folder: "f_shop", tags: ["travel"] }),
  B("shop_guitar_pedal", "Delay pedal - Sweetwater", "https://www.sweetwater.com/store/detail/delay-pedal", { cat: "shopping", folder: "f_shop", tags: ["music"] }),
  B("shop_amazon_ssd_enclosure", "NVMe enclosure - Amazon", "https://www.amazon.com/dp/B0ENCLOSURE", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_etsy_mug", "Handmade ceramic mug - Etsy", "https://www.etsy.com/listing/ceramic-mug-77", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_bnh_lens", "50mm f/1.8 lens - B&H", "https://www.bhphotovideo.com/c/product/lens-50mm", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("shop_steam_game", "Indie puzzle game - Steam", "https://store.steampowered.com/app/4400/puzzle-game", { cat: "shopping", folder: "f_shop", tags: ["gaming"] }),
  B("shop_gog_classic", "Classic RPG bundle - GOG", "https://www.gog.com/en/game/classic-rpg-bundle", { cat: "shopping", folder: "f_shop", tags: ["gaming"] }),
  B("shop_flights", "Flights to Lisbon - Google Flights", "https://www.google.com/travel/flights/s/abc123", { cat: "tool", folder: "f_travel", tags: ["travel"] }),
  B("shop_amazon_seeds", "Heirloom tomato seeds - Amazon", "https://www.amazon.com/dp/B0SEEDS", { cat: "shopping", folder: "f_shop", tags: ["cooking"] }),
  B("shop_decathlon_bike", "Bike helmet - Decathlon", "https://www.decathlon.com/p/bike-helmet-3", { cat: "shopping", folder: "f_shop", tags: ["travel"] }),
  B("shop_discogs_vinyl", "Rare jazz pressing - Discogs", "https://www.discogs.com/release/jazz-pressing-88", { cat: "shopping", folder: "f_shop", tags: ["music"] }),
  B("shop_costco_bulk", "Coffee beans 3lb - Costco", "https://www.costco.com/coffee-beans-3lb.html", { cat: "shopping", folder: "f_shop", tags: ["cooking"] }),

  // --- social (25) ---
  B("soc_reddit_rust", "r/rust: what are you working on?", "https://www.reddit.com/r/rust/comments/weekly-thread/", { cat: "social", folder: "f_social", tags: ["rust"] }),
  B("soc_reddit_cooking", "r/AskCulinary: why did my sauce split?", "https://www.reddit.com/r/AskCulinary/comments/sauce-split/", { cat: "social", folder: "f_social", tags: ["cooking"] }),
  B("soc_reddit_books", "r/suggestmeabook: what after Dune?", "https://www.reddit.com/r/suggestmeabook/comments/after-dune/", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_hn_ask", "Ask HN: best books on distributed systems?", "https://news.ycombinator.com/item?id=41002", { cat: "social", folder: "f_social", tags: ["research", "devtools"] }),
  B("soc_hn_launch", "Launch HN: searchable bookmark manager", "https://news.ycombinator.com/item?id=42001", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("soc_x_dev", "DevTools team's changelog thread", "https://x.com/devtools_team/status/180001", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("soc_mastodon_art", "Commission thread - Mastodon", "https://mastodon.art/@artist/110001", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_bluesky_news", "Analysis thread on the vote", "https://bsky.app/profile/reporter.example/post/3k2", { cat: "social", folder: "f_social", tags: ["news"] }),
  B("soc_linkedin_post", "Post: lessons from a failed startup", "https://www.linkedin.com/posts/founder_lessons-9001", { cat: "social", folder: "f_social", tags: ["career"] }),
  B("soc_reddit_travel", "r/solotravel: first solo trip tips", "https://www.reddit.com/r/solotravel/comments/first-trip/", { cat: "social", folder: "f_social", tags: ["travel"] }),
  B("soc_reddit_personalfinance", "r/personalfinance: Roth vs traditional", "https://www.reddit.com/r/personalfinance/comments/roth-vs-trad/", { cat: "social", folder: "f_social", tags: ["finance"] }),
  B("soc_lobsters", "Lobsters: deterministic builds thread", "https://lobste.rs/s/deterministic-builds", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("soc_reddit_gamedev", "r/gamedev: how do you playtest solo?", "https://www.reddit.com/r/gamedev/comments/playtest-solo/", { cat: "social", folder: "f_social", tags: ["gaming"] }),
  B("soc_reddit_plants", "r/houseplants: monstera yellowing", "https://www.reddit.com/r/houseplants/comments/monstera/", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_stackoverflow_q", "How to mock chrome.storage in Vitest?", "https://stackoverflow.com/questions/778899/chrome-storage-vitest", { cat: "reference", folder: "f_dev_js", tags: ["javascript", "reference"] }),
  B("soc_reddit_bikes", "r/bicycling: steel vs aluminum touring", "https://www.reddit.com/r/bicycling/comments/steel-touring/", { cat: "social", folder: "f_social", tags: ["travel"] }),
  B("soc_x_photo", "Photo series: empty city at dawn", "https://x.com/photog_dawn/status/180055", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_reddit_fitness", "r/Fitness: form check megathread", "https://www.reddit.com/r/Fitness/comments/form-check/", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_hn_comment", "Comment: why CSV is still fine", "https://news.ycombinator.com/item?id=43099", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("soc_reddit_language", "r/languagelearning: 6-month Japanese plan", "https://www.reddit.com/r/languagelearning/comments/japanese-plan/", { cat: "social", folder: "f_social", tags: ["travel"] }),
  B("soc_reddit_homeimprovement", "r/HomeImprovement: deck stain timing", "https://www.reddit.com/r/HomeImprovement/comments/deck-stain/", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_reddit_music", "r/LetsTalkMusic: why is bossa nova timeless", "https://www.reddit.com/r/LetsTalkMusic/comments/bossa-nova/", { cat: "social", folder: "f_social", tags: ["music"] }),
  B("soc_forum_emacs", "Emacs mailing list: org-mode 10.0", "https://lists.gnu.org/archive/html/emacs-orgmode/2026-01/msg00042.html", { cat: "social", folder: "f_social", tags: ["devtools"] }),
  B("soc_reddit_running", "r/running: first marathon training log", "https://www.reddit.com/r/running/comments/marathon-log/", { cat: "social", folder: "f_social", tags: [] }),
  B("soc_discord_invite", "Study group Discord invite", "https://discord.com/invite/study-group", { cat: "social", folder: "f_social", tags: [] }),

  // --- multilingual (15) ---
  B("ml_wiki_ja_rust", "Rust (プログラミング) - Wikipedia", "https://ja.wikipedia.org/wiki/Rust_(プログラミング)", { cat: "reference", folder: "f_ref", tags: ["rust", "reference"] }),
  B("ml_wiki_de_berlin", "Berlin - Wikipedia", "https://de.wikipedia.org/wiki/Berlin", { cat: "reference", folder: "f_travel", tags: ["travel", "reference"] }),
  B("ml_wiki_fr_recette", "Ratatouille - Wikipédia", "https://fr.wikipedia.org/wiki/Ratatouille", { cat: "reference", folder: "f_recipes", tags: ["cooking", "reference"] }),
  B("ml_zh_news", "新能源汽车电池技术突破", "https://news.example-zh.com/battery-tech", { cat: "article", folder: "f_news", tags: ["news"] }),
  B("ml_es_recipe", "Receta de paella valenciana", "https://cocina.example-es.com/paella-valenciana", { cat: "article", folder: "f_recipes", tags: ["cooking"] }),
  B("ml_pt_blog", "Guia de viagem para o Brasil", "https://viagens.example-pt.com/brasil-guia", { cat: "article", folder: "f_travel", tags: ["travel"] }),
  B("ml_ko_video", "한국어 팟캐스트 에피소드 12", "https://podcast.example-kr.com/ep12", { cat: "video", folder: "f_media", tags: ["video"] }),
  B("ml_it_docs", "Documentazione ufficiale di Python", "https://docs.example-it.com/python/", { cat: "docs", folder: "f_dev_python", tags: ["python"] }),
  B("ml_wiki_ru_space", "Космическая программа - Википедия", "https://ru.wikipedia.org/wiki/Космическая_программа", { cat: "reference", folder: "f_ref", tags: ["reference"] }),
  B("ml_wiki_ja_kyoto", "京都 - Wikipedia", "https://ja.wikipedia.org/wiki/", { cat: "reference", folder: "f_travel", tags: ["travel", "reference"] }),
  B("ml_de_forum", "Forum: Fahrrad-Wartung Grundlagen", "https://forum.example-de.com/fahrrad-wartung", { cat: "social", folder: "f_social", tags: ["travel"] }),
  B("ml_fr_video", "Tutoriel: réparer un vélo", "https://videos.example-fr.com/reparer-velo", { cat: "video", folder: "f_media", tags: ["video", "tutorial"] }),
  B("ml_es_docs", "Guía de estilo de JavaScript", "https://docs.example-es.com/javascript-style", { cat: "docs", folder: "f_dev_js", tags: ["javascript"] }),
  B("ml_zh_tool", "在线 JSON 格式化工具", "https://tools.example-zh.com/json-format", { cat: "tool", folder: "f_dev", tags: ["devtools"] }),
  B("ml_ja_shop", "陶器のオンラインショップ", "https://shop.example-jp.com/pottery", { cat: "shopping", folder: "f_shop", tags: [] }),

  // --- ambiguous / deliberately low-confidence (15) ---
  B("amb_today", "today", "https://blog.example.com/today", { cat: "article", folder: "f_read", tags: [] }),
  B("amb_index", "Index", "https://example-site.com/index", { cat: "other", folder: "f_random", tags: [] }),
  B("amb_home", "Home", "https://homepage-maker.example.com/user42", { cat: "other", folder: "f_random", tags: [] }),
  B("amb_stuff", "stuff", "https://links.example.net/stuff", { cat: "other", folder: "f_random", tags: [] }),
  B("amb_readme", "readme", "https://docs.example-repo.com/readme", { cat: "docs", folder: "f_dev", tags: [] }),
  B("amb_apple", "Apple", "https://www.apple.com/", { cat: "shopping", folder: "f_shop", tags: [] }),
  B("amb_delta", "Delta", "https://www.delta.com/", { cat: "tool", folder: "f_travel", tags: ["travel"] }),
  B("amb_orange_blog", "Orange", "https://blog.orange.example.com/", { cat: "article", folder: "f_read", tags: [] }),
  B("amb_linkedin_profile", "Profile", "https://www.linkedin.com/in/someone-public", { cat: "social", folder: "f_social", tags: ["career"] }),
  B("amb_medium_untitled", "", "https://medium.com/@unknown/untitled-post", { cat: "article", folder: "f_read", tags: [] }),
  B("amb_doc_page", "Untitled document", "https://docs.google.com/document/d/example-shared", { cat: "tool", folder: "f_random", tags: [] }),
  B("amb_drive_folder", "Shared folder", "https://drive.google.com/drive/folders/team-share", { cat: "tool", folder: "f_random", tags: [] }),
  B("amb_maps_place", "Dropped pin", "https://maps.google.com/?cid=1999", { cat: "tool", folder: "f_travel", tags: ["travel"] }),
  B("amb_pdf_paper", "paper.pdf", "https://server.example.edu/files/paper.pdf", { cat: "reference", folder: "f_ref", tags: ["research"] }),
  B("amb_archive_org", "snapshot", "https://web.archive.org/web/2020/example.com", { cat: "reference", folder: "f_archive", tags: ["reference"] }),

  // --- excluded: builtin-sensitive domains (10) ---
  B("x_bank_chase", "Chase online banking", "https://www.chase.com/", { excluded: true }),
  B("x_bank_wells", "Wells Fargo sign on", "https://www.wellsfargo.com/", { excluded: true }),
  B("x_health_mychart", "MyChart patient portal", "https://www.mychart.com/login", { excluded: true }),
  B("x_health_kp", "Kaiser Permanente member", "https://healthy.kaiserpermanente.org/", { excluded: true }),
  B("x_mail_gmail", "Gmail inbox", "https://mail.google.com/mail/u/0/", { excluded: true }),
  B("x_mail_outlook", "Outlook mail", "https://outlook.live.com/mail/", { excluded: true }),
  B("x_pay_paypal", "PayPal account", "https://www.paypal.com/myaccount/", { excluded: true }),
  B("x_bank_citi", "Citi card login", "https://www.citi.com/", { excluded: true }),
  B("x_broker_fidelity", "Fidelity investments", "https://www.fidelity.com/", { excluded: true }),
  B("x_mail_proton", "Proton Mail inbox", "https://mail.proton.me/inbox", { excluded: true }),

  // --- excluded: malformed inputs (5) ---
  B("x_bad_text", "Saved placeholder", "not a url", { excluded: true }),
  B("x_bad_scheme", "Broken paste", "ht!tp://[brackets", { excluded: true }),
  B("x_bad_noscheme", "Clipboard fragment", "://missing-scheme.com/page", { excluded: true }),
  B("x_bad_empty", "Blank entry", "http://", { excluded: true }),
  B("x_bad_partial", "Truncated host", "http://?dangling", { excluded: true }),
];

// ---------------------------------------------------------------------------
// Case generation
// ---------------------------------------------------------------------------

const cases = [];
let seq = 0;
const caseId = (kind) => `c_${kind}_${String(++seq).padStart(3, "0")}`;

/** Deterministic pick: every nth element matching a predicate. */
function pickEvery(items, n, predicate = () => true) {
  const pool = items.filter(predicate);
  return pool.filter((_, i) => i % n === 0);
}

const tagRefs = (...keys) => keys.map((k) => TAGS[k]);
const folderRefs = (...keys) => keys.map((k) => ({ id: k, path: FOLDERS[k] }));

// --- categorize: one case per covered subject (every 5th non-excluded +
//     a slice of excluded ones for exclusion coverage) ---
for (const b of pickEvery(BOOKMARKS, 5, (b) => b.cat && !b.excluded)) {
  cases.push({
    kind: "categorize",
    id: caseId("cat"),
    bookmark: b.id,
    expect: { category: b.cat },
  });
}
for (const b of pickEvery(BOOKMARKS, 3, (b) => b.excluded)) {
  cases.push({
    kind: "categorize",
    id: caseId("cat"),
    bookmark: b.id,
    expect: { category: "other" },
  });
}

// --- tags: bookmarks carrying authored tags (every 6th) ---
for (const b of pickEvery(BOOKMARKS, 6, (b) => b.tags && !b.excluded)) {
  // Candidates: the bookmark's own tags plus a stable distractor set.
  const distractors = ["news", "cooking", "gaming", "finance", "music", "travel"];
  const candKeys = [...new Set([...b.tags, ...distractors])];
  cases.push({
    kind: "tags",
    id: caseId("tags"),
    bookmark: b.id,
    tags: tagRefs(...candKeys),
    expect: { tags: [...b.tags] },
  });
}

// --- placement: bookmarks with an authored folder (every 5th) ---
const PLACEMENT_POOL = [
  "f_dev", "f_dev_js", "f_dev_rust", "f_dev_python", "f_news", "f_media",
  "f_read", "f_shop", "f_social", "f_recipes", "f_travel", "f_ref",
  "f_archive", "f_random",
];
for (const b of pickEvery(BOOKMARKS, 5, (b) => b.folder && !b.excluded)) {
  // Candidates: the right folder + 4 neighbors rotated by id hash.
  const right = b.folder;
  const others = PLACEMENT_POOL.filter((f) => f !== right);
  const offset = b.id.length % others.length;
  const picks = [right, ...others.slice(offset), ...others.slice(0, offset)].slice(0, 5);
  cases.push({
    kind: "placement",
    id: caseId("place"),
    bookmark: b.id,
    folders: folderRefs(...picks),
    expect: { folder: right },
  });
}
// A few no-fit cases.
for (const b of pickEvery(BOOKMARKS, 97, (b) => b.folder && !b.excluded)) {
  const cand = PLACEMENT_POOL.filter((f) => f !== b.folder).slice(0, 5);
  cases.push({
    kind: "placement",
    id: caseId("place"),
    bookmark: b.id,
    folders: folderRefs(...cand),
    expect: { folder: "none" },
  });
}

// --- misfiled: bookmarks whose current folder is NOT their authored one ---
const MISFILED_WRONG = {
  f_dev_js: "f_random", f_dev_rust: "f_archive", f_dev_python: "f_dev_js",
  f_dev: "f_random", f_news: "f_read", f_media: "f_random",
  f_read: "f_archive", f_shop: "f_random", f_social: "f_archive",
  f_recipes: "f_random", f_travel: "f_archive", f_ref: "f_random",
};
// Dedupe by folder id, keeping the first occurrence (order matters: the
// current and expected entries must survive).
function uniqFolders(list) {
  const seen = new Set();
  return list.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
}
for (const b of pickEvery(BOOKMARKS, 6, (b) => b.folder && !b.excluded)) {
  const wrong = MISFILED_WRONG[b.folder] ?? "f_random";
  cases.push({
    kind: "misfiled",
    id: caseId("mis"),
    bookmark: b.id,
    folderPath: FOLDERS[wrong],
    folders: uniqFolders([
      { id: wrong, path: FOLDERS[wrong], current: true },
      ...folderRefs(b.folder, "f_dev", "f_read", "f_archive"),
    ]),
    expect: { folder: b.folder },
  });
}
// Correctly-filed coverage: expected = current folder.
for (const b of pickEvery(BOOKMARKS, 29, (b) => b.folder && !b.excluded)) {
  cases.push({
    kind: "misfiled",
    id: caseId("mis"),
    bookmark: b.id,
    folderPath: FOLDERS[b.folder],
    folders: uniqFolders([
      { id: b.folder, path: FOLDERS[b.folder], current: true },
      ...folderRefs("f_dev", "f_archive", "f_read"),
    ]),
    expect: { folder: b.folder },
  });
}

// --- near_duplicate: curated pairs by same_content level (1–4) ---
const PAIRS = [
  // level 4 — identical page
  ["docs_mdn_fetch", "dup_mdn_fetch_amp", 4],
  ["repo_rust", "dup_repo_rust_mirror", 4],
  ["vid_yt_lecture", "dup_yt_lecture_2", 4],
  // level 3 — same content, different URL/version
  ["docs_rust_book_ch4", "dup_rust_book_stable", 3],
  ["art_bbc_climate", "dup_bbc_climate_amp", 3],
  ["docs_python_asyncio", "dup_python_asyncio_312", 3],
  ["repo_typescript", "dup_ts_gitlab_mirror", 3],
  ["ref_arxiv_transformer", "dup_arxiv_abs_v2", 3],
  ["vid_yt_rustconf", "dup_rustconf_peertube", 3],
  ["docs_react_hooks", "dup_react_hooks_legacy", 3],
  // level 2 — same topic, different content
  ["docs_rust_std_vec", "art_medium_rust", 2],
  ["ref_wiki_rust", "repo_rust", 2],
  ["art_recipe_bread", "vid_yt_bread", 2],
  ["docs_python_urllib", "docs_python_asyncio", 2],
  ["art_travel_japan", "ref_wiki_japan", 2],
  ["docs_mdn_fetch", "ref_so_async", 2],
  ["vid_yt_climbing", "art_outdoors_hike", 2],
  ["shop_amazon_keyboard", "shop_etsy_mug", 2],
  ["repo_react", "docs_react_thinking", 2],
  ["art_game_design", "ref_wiki_chess", 2],
  ["ref_arxiv_llm", "art_wired_ai", 2],
  ["vid_yt_guitar", "art_music_theory", 2],
  ["docs_k8s_pods", "docs_docker_compose", 2],
  ["art_lwn_kernel", "repo_linux", 2],
  // level 1 — unrelated
  ["docs_mdn_array", "shop_ebay_camera", 1],
  ["vid_yt_cooking", "repo_kubernetes", 1],
  ["art_nyt_economy", "tool_regex101", 1],
  ["ref_wiki_bird", "repo_neovim", 1],
  ["soc_reddit_rust", "shop_rei_jacket", 1],
  ["docs_jq_manual", "vid_yt_f1", 1],
  ["tool_figma", "ref_wiki_french_rev", 1],
  ["shop_amazon_book", "ml_es_recipe", 1],
];
// The dup_* partners are dedicated fixtures — appended below.
for (const [a, b, level] of PAIRS) {
  cases.push({
    kind: "near_duplicate",
    id: caseId("dup"),
    a,
    b,
    expect: { same_content: level },
  });
}

// --- rerank: curated queries ---
const RERANK = [
  ["rust async", ["docs_tokio_tutorial", "vid_yt_rust_live", "repo_tokio", "docs_rust_std_vec", "shop_amazon_book"], ["docs_tokio_tutorial", "vid_yt_rust_live", "repo_tokio"]],
  ["python http requests", ["docs_python_urllib", "repo_pypi_requests", "docs_python_asyncio", "ref_so_docker"], ["docs_python_urllib", "repo_pypi_requests"]],
  ["mechanical keyboard", ["shop_amazon_keyboard", "art_verge_gadget", "repo_vscode", "tool_colorhunt"], ["shop_amazon_keyboard", "art_verge_gadget"]],
  ["javascript array methods", ["docs_mdn_array", "ref_so_async", "docs_mdn_fetch", "repo_react"], ["docs_mdn_array"]],
  ["sourdough bread", ["art_recipe_bread", "vid_yt_bread", "ref_wiki_sourdough", "shop_amazon_seeds"], ["art_recipe_bread", "vid_yt_bread", "ref_wiki_sourdough"]],
  ["kubernetes pods", ["docs_k8s_pods", "repo_kubernetes", "docs_docker_compose", "tool_crontab"], ["docs_k8s_pods", "repo_kubernetes"]],
  ["film camera", ["shop_ebay_camera", "vid_yt_photo", "art_photo_film", "ref_imdb_film"], ["shop_ebay_camera", "vid_yt_photo", "art_photo_film"]],
  ["react hooks", ["docs_react_hooks", "art_devto_hooks", "repo_react", "docs_react_thinking"], ["docs_react_hooks", "art_devto_hooks", "repo_react"]],
  ["climate summit", ["art_bbc_climate", "art_guardian_climate", "ref_wiki_japan"], ["art_bbc_climate", "art_guardian_climate"]],
  ["index fund fees", ["art_substack_finance", "ref_investopedia_etf", "art_ft_fintech", "ref_currency_xe"], ["art_substack_finance", "ref_investopedia_etf"]],
  ["typescript config", ["docs_tsconfig", "repo_typescript", "docs_vite_config", "tool_bundlephobia"], ["docs_tsconfig", "repo_typescript"]],
  ["japan travel", ["art_travel_japan", "ref_wiki_japan", "vid_yt_travel", "ml_wiki_ja_kyoto"], ["art_travel_japan", "ref_wiki_japan", "vid_yt_travel", "ml_wiki_ja_kyoto"]],
  ["docker compose", ["docs_docker_compose", "repo_docker", "ref_so_docker", "docs_k8s_pods"], ["docs_docker_compose", "repo_docker"]],
  ["guitar tutorial", ["vid_yt_guitar", "shop_guitar_pedal", "art_music_theory"], ["vid_yt_guitar"]],
  ["machine learning course", ["vid_coursera_ml", "ref_arxiv_transformer", "ref_arxiv_llm", "art_wired_ai"], ["vid_coursera_ml"]],
  ["remote work data", ["art_econ_remote", "soc_linkedin_post", "tool_timezone"], ["art_econ_remote"]],
  ["regex tester", ["tool_regex101", "docs_regex_mdn", "tool_jsonpath"], ["tool_regex101", "docs_regex_mdn"]],
  ["camping gear", ["shop_rei_jacket", "shop_walmart_tent", "art_outdoors_hike", "vid_yt_climbing"], ["shop_walmart_tent", "shop_rei_jacket"]],
  ["pasta recipe", ["ml_es_recipe", "art_recipe_ramen", "vid_yt_cooking", "ref_usda_food"], ["ml_es_recipe", "art_recipe_ramen"]],
  ["git tricks", ["docs_git_ref", "art_blog_git", "ref_so_gitignore", "soc_hn_comment"], ["docs_git_ref", "art_blog_git"]],
  ["rust ownership", ["docs_rust_book_ch4", "ref_so_rust_lifetime", "docs_rust_nomicon", "repo_rust"], ["docs_rust_book_ch4", "ref_so_rust_lifetime", "docs_rust_nomicon"]],
  ["game speedrun", ["vid_yt_gaming", "art_game_design", "shop_steam_game", "soc_reddit_gamedev"], ["vid_yt_gaming"]],
  ["web scraping", ["docs_python_urllib", "repo_pypi_requests", "tool_jsonpath", "amb_pdf_paper"], []],
  ["marathon training", ["soc_reddit_running", "vid_yt_fitness", "shop_zappos_shoes"], ["soc_reddit_running"]],
  ["self-hosted photos", ["repo_immich", "repo_bitwarden", "art_blog_selfhost", "repo_awesome_selfhosted"], ["repo_immich", "art_blog_selfhost", "repo_awesome_selfhosted"]],
  ["dark mode css", ["docs_mdn_css_grid", "art_devto_css", "tool_caniuse"], ["art_devto_css", "tool_caniuse"]],
  ["bike touring", ["art_cycling_alps", "shop_decathlon_bike", "ml_de_forum", "soc_reddit_bikes"], ["art_cycling_alps", "ml_de_forum", "soc_reddit_bikes"]],
  ["vinyl records", ["shop_bandcamp_vinyl", "shop_discogs_vinyl", "soc_reddit_music"], ["shop_bandcamp_vinyl", "shop_discogs_vinyl"]],
  ["file system api", ["docs_node_fs", "docs_mdn_fetch", "ref_papers_gfs"], ["docs_node_fs"]],
  ["401k investing", ["ref_investopedia_etf", "art_substack_finance", "x_broker_fidelity"], ["ref_investopedia_etf", "art_substack_finance"]],
];
for (const [query, candidates, matches] of RERANK) {
  cases.push({
    kind: "rerank",
    id: caseId("rerank"),
    query,
    candidates,
    expect: { matches },
  });
}

// Near-duplicate partner fixtures (level-3/4 copies live only here so the
// main pool stays realistic).
const DUP_FIXTURES = [
  B("dup_mdn_fetch_amp", "Using the Fetch API - MDN", "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch?utm_source=rss", {}),
  B("dup_repo_rust_mirror", "rust-lang/rust (fork)", "https://github.com/rust-lang/rust", {}),
  B("dup_yt_lecture_2", "MIT 6.824 distributed systems lecture 1", "https://www.youtube.com/watch?v=mit-6824-lec1", {}),
  B("dup_rust_book_stable", "Understanding Ownership - The Rust Book (stable)", "https://doc.rust-lang.org/stable/book/ch04-00-understanding-ownership.html", {}),
  B("dup_bbc_climate_amp", "Climate summit reaches tentative agreement", "https://www.bbc.com/news/science-environment-68001.amp", {}),
  B("dup_python_asyncio_312", "asyncio — Asynchronous I/O (3.12)", "https://docs.python.org/3.12/library/asyncio.html", {}),
  B("dup_ts_gitlab_mirror", "TypeScript mirror", "https://gitlab.com/mirrors/TypeScript", {}),
  B("dup_arxiv_abs_v2", "Attention Is All You Need v2 - arXiv", "https://arxiv.org/abs/1706.03762v2", {}),
  B("dup_rustconf_peertube", "RustConf 2025 keynote (mirror)", "https://videos.example.com/w/rustconf25", {}),
  B("dup_react_hooks_legacy", "Hooks API Reference – React (legacy docs)", "https://legacy.reactjs.org/docs/hooks-reference.html", {}),
];

const allBookmarks = [...BOOKMARKS, ...DUP_FIXTURES].map(
  ({ id, title, url, excluded }) =>
    excluded === true ? { id, title, url, excluded: true } : { id, title, url },
);

const corpus = {
  version: "1.0.0",
  questionSetVersions: {
    categorize: "categorize-v1",
    tags: "tags-v1",
    placement: "placement-v1",
    misfiled: "misfiled-v1",
    nearDuplicate: "near-duplicate-v1",
    rerank: "rerank-v1",
  },
  bookmarks: allBookmarks,
  cases,
};

// Fail fast on authoring mistakes before writing.
const ids = new Set();
for (const b of allBookmarks) {
  if (ids.has(b.id)) throw new Error(`duplicate bookmark id ${b.id}`);
  ids.add(b.id);
}
for (const c of cases) {
  const refs =
    c.kind === "near_duplicate" ? [c.a, c.b]
    : c.kind === "rerank" ? c.candidates
    : [c.bookmark];
  for (const r of refs) {
    if (!ids.has(r)) throw new Error(`case ${c.id} references missing ${r}`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(
  `wrote ${OUT}: ${allBookmarks.length} bookmarks, ${cases.length} cases`,
);
