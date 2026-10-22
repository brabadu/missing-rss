# missing-rss

RSS-фіди для сайтів, у яких їх немає. Раз на добу GitHub Actions відкриває сторінки зі
списку в [`feeds.yaml`](feeds.yaml) через Playwright (headless Chromium), витягує статті і
публікує RSS на GitHub Pages. CSS-селектори для кожного сайту підбирає LLM через OpenRouter.

Фіди: `https://<user>.github.io/missing-rss/<id>.xml`, список усіх — на головній сторінці,
OPML для імпорту в рідер — `feeds.opml`.

## Як додати сайт

```yaml
feeds:
  - id: my-blog                   # -> my-blog.xml
    url: https://example.com/blog
```

Цього достатньо. За бажанням можна задати `title`, `min_items`, `max_items`, `wait_for` або
ручні `selectors: {item, title, link, date, description}` — тоді LLM для цього фіду не
використовується.

## Як працює LLM

LLM не парсить статті щодня — вона **один раз підбирає селектори**, далі скрейпінг
детермінований:

1. Сторінка завантажується, з неї робиться стиснутий HTML: без скриптів, стилів, svg, nav/footer,
   з короткими текстами і згорнутими однотипними елементами (`<!-- 20 more similar -->`).
   Типова сторінка — 10–20 тис. символів.
2. Модель повертає JSON `{item, title, link, date, description}`.
3. Селектори **перевіряються на живій сторінці**: мінімум 3 статті із заголовком і посиланням,
   різні заголовки, адекватна довжина. Дата, яка не парситься, просто відкидається.
4. Якщо перевірка не пройшла — модель отримує опис проблеми і перші витягнуті елементи і
   пробує виправити (`repair_rounds`). Не вийшло, помилка API, rate limit — наступна модель.
5. Робочі селектори кешуються в `<id>.json` (разом з назвою моделі). Наступні запуски LLM не
   викликають, поки селектори працюють. Коли сайт змінює верстку (або хешовані класи після
   деплою) і перевірка падає — селектори підбираються заново автоматично.

**Моделі.** Безкоштовні моделі на OpenRouter з'являються і зникають, тому список не зашитий
у код: на кожному запуску береться актуальний `/models`, з нього — безкоштовні з достатнім
контекстом, від найбільшого контексту. У `feeds.yaml` → `llm.models` можна задати моделі, які
пробувати першими, а в `llm.exclude` — ті, що дають погані результати. Модель, яка зникла з
OpenRouter, просто пропускається.

Через кешування LLM викликається рідко, тож ліміти безкоштовних моделей (~50 запитів на добу
без кредитів) не проблема.

## Налаштування (один раз)

1. Settings → Secrets and variables → Actions → New repository secret:
   `OPENROUTER_API_KEY` = ключ з https://openrouter.ai/keys.
2. Запустіть workflow **Build RSS feeds** (Actions → Run workflow) — він створить гілку `gh-pages`.
3. Settings → Pages → Source: **Deploy from a branch**, гілка `gh-pages`, папка `/ (root)`.

Workflow запускається щодня о 05:17 UTC, вручну і при зміні конфігу. Ручний запуск з
галочкою `redetect` заново підбирає селектори для всіх фідів. Якщо фід зламався, у лозі
Actions з'являється помилка, а попередня версія цього фіду лишається опублікованою.

## Локально

```sh
npm ci
npx playwright install chromium
OPENROUTER_API_KEY=sk-or-... node src/build.mjs my-blog     # або без id — усі фіди
node src/build.mjs --redetect my-blog                         # ігнорувати кеш селекторів
cat public/my-blog.xml public/my-blog.json
```

`public/` локально — це той самий стан, що й гілка `gh-pages` у CI.

Перевірити LLM-логіку без ключа можна з фейковим OpenRouter (`test/mock-openrouter.mjs`):

```sh
npm run mock-openrouter &
OPENROUTER_BASE_URL=http://127.0.0.1:8787 OPENROUTER_API_KEY=test node src/build.mjs --redetect
```
