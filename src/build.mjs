// Scrapes the pages listed in feeds.yaml with Playwright and writes RSS feeds to public/.
// Selectors come from feeds.yaml if given, otherwise an LLM finds them once; they are cached
// in public/<id>.json and re-detected only when they stop working.
//
// Usage: node src/build.mjs [--redetect] [feed-id ...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { loadPage, simplifiedHtml, validateSelectors } from './page.mjs';
import { detectSelectors, hasLlm } from './llm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(ROOT, 'public');
const DEFAULT_MAX_ITEMS = 50;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const config = YAML.parse(await readFile(path.join(ROOT, 'feeds.yaml'), 'utf8'));
const site = config.site ?? {};
const llmConfig = config.llm ?? {};
const baseUrl = (site.base_url || process.env.SITE_URL || '').replace(/\/+$/, '');
const args = process.argv.slice(2);
const redetect = args.includes('--redetect') || process.env.REDETECT === 'true';
const only = args.filter((a) => !a.startsWith('--'));
const allFeeds = config.feeds ?? [];
const feeds = allFeeds.filter((f) => only.length === 0 || only.includes(f.id));

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: USER_AGENT });
let failed = 0;

for (const feed of feeds) {
  try {
    const state = await readState(feed);
    const { items: scraped, selectors, model, title } = await scrape(feed, state);
    const items = mergeItems(feed, state.items, scraped);
    const next = { ...state, title, selectors, items };
    if (model) next.selectors = { ...selectors, model, detected_at: new Date().toISOString() };
    await writeFile(statePath(feed), JSON.stringify(next, null, 2));
    await writeFile(path.join(OUT_DIR, `${feed.id}.xml`), renderRss(feed, next));
    console.log(`✓ ${feed.id}: ${scraped.length} scraped, ${items.length} in feed`);
  } catch (err) {
    failed++;
    // Keep the previously published files for this feed untouched.
    console.log(`::error title=${feed.id}::${err.message.replace(/\n/g, '%0A')}`);
  }
}

await browser.close();
const titles = Object.fromEntries(
  await Promise.all(allFeeds.map(async (f) => [f.id, f.title ?? (await readState(f)).title ?? f.url])),
);
await writeFile(path.join(OUT_DIR, 'index.html'), renderIndex(allFeeds, titles));
await writeFile(path.join(OUT_DIR, 'feeds.opml'), renderOpml(allFeeds, titles));

if (feeds.length > 0 && failed === feeds.length) process.exit(1);

async function scrape(feed, state) {
  const manual = feed.selectors?.item ? feed.selectors : null;
  const page = await loadPage(context, feed.url, feed.wait_for ?? manual?.item);
  try {
    const title = feed.title ?? ((await page.title()) || feed.url);
    const opts = { minItems: feed.min_items ?? 3 };

    if (manual) {
      const res = await validateSelectors(page, manual, opts);
      if (!res.ok) throw new Error(`configured selectors failed: ${res.problem}`);
      return { title, items: res.items, selectors: res.selectors };
    }

    const cached = state.selectors;
    if (cached?.item && !redetect) {
      const res = await validateSelectors(page, cached, opts);
      if (res.ok) return { title, items: res.items, selectors: cached };
      console.log(`${feed.id}: cached selectors stopped working (${res.problem}), asking the LLM again`);
    }

    if (!hasLlm()) throw new Error('no working selectors and OPENROUTER_API_KEY is not set');
    console.log(`${feed.id}: detecting selectors with the LLM`);
    const html = await simplifiedHtml(page, llmConfig.max_html_chars);
    const found = await detectSelectors({
      url: feed.url,
      html,
      llmConfig,
      validate: (sel) => validateSelectors(page, sel, opts),
      log: (msg) => console.log(msg),
    });
    return { title, items: found.items, selectors: found.selectors, model: found.model };
  } finally {
    await page.close();
  }
}

function statePath(feed) {
  return path.join(OUT_DIR, `${feed.id}.json`);
}

async function readState(feed) {
  try {
    return JSON.parse(await readFile(statePath(feed), 'utf8'));
  } catch {
    return {};
  }
}

// Items persist between runs, so entries keep a stable first-seen date when the page has no
// dates and don't vanish once they scroll off the page.
function mergeItems(feed, previous = [], scraped) {
  const now = new Date().toISOString();
  const byLink = new Map(previous.map((it) => [it.link, it]));
  for (const it of scraped) {
    const old = byLink.get(it.link);
    const parsed = Date.parse(it.date);
    byLink.set(it.link, {
      title: it.title,
      link: it.link,
      description: it.description || old?.description || '',
      firstSeen: old?.firstSeen ?? now,
      date: Number.isNaN(parsed) ? (old?.date ?? old?.firstSeen ?? now) : new Date(parsed).toISOString(),
    });
  }

  return [...byLink.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, feed.max_items ?? DEFAULT_MAX_ITEMS);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function feedUrl(feed) {
  return `${baseUrl}/${feed.id}.xml`;
}

function renderRss(feed, { title, items }) {
  const entries = items
    .map(
      (it) => `    <item>
      <title>${esc(it.title)}</title>
      <link>${esc(it.link)}</link>
      <guid isPermaLink="true">${esc(it.link)}</guid>
      <pubDate>${new Date(it.date).toUTCString()}</pubDate>${it.description ? `\n      <description>${esc(it.description)}</description>` : ''}
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(feed.url)}</link>
    <description>${esc(feed.description ?? `Unofficial RSS feed for ${feed.url}`)}</description>
    <atom:link href="${esc(feedUrl(feed))}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
}

function renderIndex(allFeeds, titles) {
  const rows = allFeeds
    .map(
      (f) =>
        `    <li><a href="${esc(f.id)}.xml">${esc(titles[f.id])}</a> — <a href="${esc(f.url)}">${esc(f.url)}</a></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(site.title ?? 'Missing RSS')}</title>
${allFeeds.map((f) => `  <link rel="alternate" type="application/rss+xml" title="${esc(titles[f.id])}" href="${esc(f.id)}.xml">`).join('\n')}
  <style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
  <h1>${esc(site.title ?? 'Missing RSS')}</h1>
  <p>${esc(site.description ?? '')}</p>
  <ul>
${rows}
  </ul>
  <p><a href="feeds.opml">OPML</a> · updated ${new Date().toUTCString()}</p>
</body>
</html>
`;
}

function renderOpml(allFeeds, titles) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>${esc(site.title ?? 'Missing RSS')}</title></head>
  <body>
${allFeeds.map((f) => `    <outline type="rss" text="${esc(titles[f.id])}" title="${esc(titles[f.id])}" xmlUrl="${esc(feedUrl(f))}" htmlUrl="${esc(f.url)}"/>`).join('\n')}
  </body>
</opml>
`;
}
