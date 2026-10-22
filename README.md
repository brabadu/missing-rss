# missing-rss

RSS-фіди для сайтів, у яких їх немає. Раз на добу GitHub Actions відкриває сторінки зі
списку в [`feeds.yaml`](feeds.yaml) через Playwright (headless Chromium), витягує статті
за CSS-селекторами і публікує RSS на GitHub Pages.

Фіди: `https://<user>.github.io/missing-rss/<id>.xml`, список усіх — на головній сторінці,
OPML для імпорту в рідер — `feeds.opml`.

## Як додати сайт

Додайте запис у `feeds.yaml`:

```yaml
  - id: my-blog                 # -> my-blog.xml
    title: My Blog
    url: https://example.com/blog
    item: "article.post"        # одна картка статті
    title_selector: h2          # усі *_selector — відносно item, опційні
    link_selector: h2 a
    date_selector: time         # атрибут datetime або текст; без дати — береться дата першої появи
    description_selector: p.excerpt
```

Перевірити локально:

```sh
npm ci
npx playwright install chromium
node src/build.mjs my-blog      # або npm run build для всіх
cat public/my-blog.xml
```

Селектори зручно підбирати в DevTools: `document.querySelectorAll("article.post")`.

## Як це працює

- `src/build.mjs` — скрейпить кожен фід, дедуплікує за посиланням, зливає з попередньою
  версією (`public/<id>.json`), тож статті, що зникли зі сторінки, лишаються у фіді, а дата
  першої появи стабільна. Тримається до `max_items` (50) останніх елементів.
- Якщо фід зламався (сайт недоступний або селектор нічого не знайшов) — у лозі Actions
  з'являється помилка, а попередня версія цього фіду лишається опублікованою.
- `.github/workflows/build.yml` — щоденний запуск (05:17 UTC), ручний запуск і запуск при
  зміні конфігу; результат пушиться в гілку `gh-pages`.

## Налаштування GitHub Pages (один раз)

1. Запустіть workflow **Build RSS feeds** (Actions → Run workflow) — він створить гілку `gh-pages`.
2. Settings → Pages → Source: **Deploy from a branch**, гілка `gh-pages`, папка `/ (root)`.
