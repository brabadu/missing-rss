# missing-rss

RSS feeds for sites that don't have one. Once a day GitHub Actions opens the pages listed in
[`feeds.yaml`](feeds.yaml) with Playwright (headless Chromium), extracts the articles and
publishes RSS to GitHub Pages. CSS selectors for each site are found by an LLM via OpenRouter.

Feeds live at `https://<user>.github.io/missing-rss/<id>.xml`; the home page lists them all,
and `feeds.opml` imports them into a reader in one go.

## Adding a site

```yaml
feeds:
  - id: my-blog                   # -> my-blog.xml
    url: https://example.com/blog
```

That's enough. Optionally set `title`, `min_items`, `max_items`, `wait_for`, or manual
`selectors: {item, title, link, date, description}`, in which case the LLM is not used for
that feed.

## How the LLM is used

The LLM doesn't parse articles every day — it **finds selectors once**, and scraping is
deterministic after that:

1. The page is loaded and turned into compact HTML: no scripts, styles, svg or nav/footer,
   short texts, and runs of similar elements collapsed (`<!-- 20 more similar -->`).
   A typical page is 10–20k characters.
2. The model returns JSON `{item, title, link, date, description}`.
3. The selectors are **validated against the live page**: at least 3 articles with a title and
   a link, distinct titles, sensible title length. A date that doesn't parse is simply dropped.
4. If validation fails, the model gets the problem description and the first extracted items
   and tries to fix its answer (`repair_rounds`). Still failing, an API error or a rate
   limit — on to the next model.
5. Working selectors are cached in `<id>.json` (together with the model name). Later runs don't
   call the LLM while the selectors keep working. When the site changes its markup (or its
   hashed class names after a deploy) and validation fails, selectors are re-detected
   automatically.

**Models.** Free models on OpenRouter come and go, so the list isn't hard-coded: every run
fetches the current `/models` and takes free text-only models with enough context (no
music/image generators or guard classifiers), ranked by the Artificial Analysis benchmarks that
OpenRouter returns in the same list (coding + intelligence index). Models without benchmarks
come next, and the `openrouter/free` router goes last. In `feeds.yaml`, `llm.models` sets models
to try first and `llm.exclude` bans models that give poor results or don't work through the API
(`*` wildcards allowed, e.g. `thinkingmachines/inkling*`). A model that disappeared from
OpenRouter is simply skipped, and a model that returns an error is not asked again for the
remaining feeds of the run.

Thanks to caching, the LLM is called rarely, so free-model limits (~50 requests a day without
credits) aren't a problem.

## Setup (once)

1. Settings → Secrets and variables → Actions → New repository secret:
   `OPENROUTER_API_KEY` = a key from https://openrouter.ai/keys.
2. Run the **Build RSS feeds** workflow (Actions → Run workflow) — it creates the `gh-pages` branch.
3. Settings → Pages → Source: **Deploy from a branch**, branch `gh-pages`, folder `/ (root)`.

The workflow runs daily at 05:17 UTC, on demand, and when the config changes. A manual run with
`redetect` checked re-detects selectors for all feeds. If a feed breaks, an error shows up in the
Actions log and the previously published version of that feed stays online.

## Running locally

```sh
npm ci
npx playwright install chromium
OPENROUTER_API_KEY=sk-or-... node src/build.mjs my-blog     # or no id for all feeds
node src/build.mjs --redetect my-blog                         # ignore cached selectors
cat public/my-blog.xml public/my-blog.json
```

Locally, `public/` holds the same state as the `gh-pages` branch does in CI.

To exercise the LLM logic without a key, use the fake OpenRouter (`test/mock-openrouter.mjs`):

```sh
npm run mock-openrouter &
OPENROUTER_BASE_URL=http://127.0.0.1:8787 OPENROUTER_API_KEY=test node src/build.mjs --redetect
```
