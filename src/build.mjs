// Scrapes the pages listed in feeds.yaml with Playwright and writes RSS feeds to public/.
// Usage: node src/build.mjs [feed-id ...]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(ROOT, 'public');
const DEFAULT_MAX_ITEMS = 50;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const config = YAML.parse(await readFile(path.join(ROOT, 'feeds.yaml'), 'utf8'));
const site = config.site ?? {};
const baseUrl = (site.base_url || process.env.SITE_URL || '').replace(/\/+$/, '');
const only = process.argv.slice(2);
const feeds = (config.feeds ?? []).filter((f) => only.length === 0 || only.includes(f.id));

await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: USER_AGENT });
let failed = 0;

for (const feed of feeds) {
  try {
    const scraped = await scrape(context, feed);
    if (scraped.length === 0) throw new Error(`selector "${feed.item}" matched no items`);
    const items = await mergeWithPrevious(feed, scraped);
    await writeFile(path.join(OUT_DIR, `${feed.id}.json`), JSON.stringify(items, null, 2));
    await writeFile(path.join(OUT_DIR, `${feed.id}.xml`), renderRss(feed, items));
    console.log(`✓ ${feed.id}: ${scraped.length} scraped, ${items.length} in feed`);
  } catch (err) {
    failed++;
    // Keep the previously published files for this feed untouched.
    console.log(`::error title=${feed.id}::${err.message.split('\n')[0]}`);
  }
}

await browser.close();
await writeFile(path.join(OUT_DIR, 'index.html'), renderIndex(config.feeds ?? []));
await writeFile(path.join(OUT_DIR, 'feeds.opml'), renderOpml(config.feeds ?? []));

if (feeds.length > 0 && failed === feeds.length) process.exit(1);

async function scrape(context, feed) {
  const page = await context.newPage();
  try {
    await page.goto(feed.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(feed.wait_for ?? feed.item, { timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    const raw = await page.$$eval(
      feed.item,
      (nodes, sel) => {
        const pick = (root, s) => (s ? root.querySelector(s) : null);
        const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
        return nodes.map((node) => {
          const linkEl = sel.link
            ? pick(node, sel.link)
            : node.matches('a[href]')
              ? node
              : node.querySelector('a[href]');
          const dateEl = pick(node, sel.date);
          return {
            title: text(sel.title ? pick(node, sel.title) : node),
            link: linkEl ? linkEl.href : '',
            date: dateEl ? dateEl.getAttribute('datetime') || text(dateEl) : '',
            description: text(pick(node, sel.description)),
          };
        });
      },
      {
        title: feed.title_selector,
        link: feed.link_selector,
        date: feed.date_selector,
        description: feed.description_selector,
      },
    );

    const seen = new Set();
    return raw.filter((it) => {
      if (!it.title || !it.link || seen.has(it.link)) return false;
      seen.add(it.link);
      return true;
    });
  } finally {
    await page.close();
  }
}

// Items persist between runs (via the published <id>.json), so entries keep a stable
// first-seen date when the page has no dates and don't vanish once they scroll off the page.
async function mergeWithPrevious(feed, scraped) {
  let previous = [];
  try {
    previous = JSON.parse(await readFile(path.join(OUT_DIR, `${feed.id}.json`), 'utf8'));
  } catch {}

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

function renderRss(feed, items) {
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
    <title>${esc(feed.title)}</title>
    <link>${esc(feed.url)}</link>
    <description>${esc(feed.description ?? `Unofficial RSS feed for ${feed.url}`)}</description>
    <atom:link href="${esc(feedUrl(feed))}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
}

function renderIndex(allFeeds) {
  const rows = allFeeds
    .map(
      (f) =>
        `    <li><a href="${esc(f.id)}.xml">${esc(f.title)}</a> — <a href="${esc(f.url)}">${esc(f.url)}</a></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(site.title ?? 'Missing RSS')}</title>
${allFeeds.map((f) => `  <link rel="alternate" type="application/rss+xml" title="${esc(f.title)}" href="${esc(f.id)}.xml">`).join('\n')}
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

function renderOpml(allFeeds) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>${esc(site.title ?? 'Missing RSS')}</title></head>
  <body>
${allFeeds.map((f) => `    <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(feedUrl(f))}" htmlUrl="${esc(f.url)}"/>`).join('\n')}
  </body>
</opml>
`;
}
