// Page helpers: loading, extracting items with selectors, checking the result, and a compact
// HTML rendering of the page for the LLM.

export async function loadPage(context, url, waitFor) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // Trigger lazy-loaded lists.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return page;
}

// Returns { count, items } or { error } for an invalid selector.
export async function extractItems(page, sel) {
  return page.evaluate((sel) => {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    try {
      const nodes = [...document.querySelectorAll(sel.item)];
      const pick = (root, s) => (s ? root.querySelector(s) : null);
      const seen = new Set();
      const items = [];
      for (const node of nodes) {
        const linkEl = sel.link
          ? pick(node, sel.link)
          : node.closest('a[href]') || node.querySelector('a[href]');
        const dateEl = pick(node, sel.date);
        const item = {
          title: text(sel.title ? pick(node, sel.title) : node),
          link: linkEl ? linkEl.href : '',
          date: dateEl ? dateEl.getAttribute('datetime') || text(dateEl) : '',
          description: text(pick(node, sel.description)),
        };
        if (!item.title || !item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        items.push(item);
      }
      return { count: nodes.length, items };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }, sel);
}

// Decides whether selectors produce a believable article list. Drops a date selector that
// yields unparseable dates instead of rejecting everything.
export async function validateSelectors(page, sel, { minItems = 3 } = {}) {
  const res = await extractItems(page, sel);
  const fail = (problem, items = []) => ({ ok: false, problem, items, selectors: sel });

  if (res.error) return fail(`invalid selector: ${res.error}`);
  if (res.count === 0) return fail(`"item" selector "${sel.item}" matched no elements`);

  const { items } = res;
  if (items.length < minItems) {
    return fail(
      `only ${items.length} unique items with both title and link ("item" matched ${res.count} elements), expected at least ${minItems}`,
      items,
    );
  }
  if (new Set(items.map((i) => i.title)).size === 1) {
    return fail(`all items have the same title "${items[0].title}"`, items);
  }
  const avgTitle = items.reduce((n, i) => n + i.title.length, 0) / items.length;
  if (avgTitle > 250) return fail('titles are too long, the title selector probably captures the whole card', items);

  if (sel.date) {
    const parsed = items.filter((i) => !Number.isNaN(Date.parse(i.date))).length;
    if (parsed < items.length / 2) {
      sel = { ...sel, date: null };
      for (const i of items) i.date = '';
    }
  }
  return { ok: true, items, selectors: sel };
}

// Compact HTML for the LLM: no scripts/styles/svg, only selector-relevant attributes, short
// text, and long runs of similar siblings collapsed.
export async function simplifiedHtml(page, maxChars = 60_000) {
  const html = await page.evaluate(() => {
    const DROP = new Set(
      'script style noscript svg iframe link meta template canvas video audio source picture img form button input select textarea dialog nav footer'.split(' '),
    );
    const ATTR = /^(id|class|href|datetime|role|data-[\w-]+)$/;
    const KEEP_SIMILAR = 4;
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    const attrs = (el) =>
      [...el.attributes]
        .filter((a) => ATTR.test(a.name))
        .map((a) => {
          let v = a.value.trim();
          // Whole class names only: a truncated one would be useless as a selector.
          if (a.name === 'class') v = v.split(/\s+/).slice(0, 3).join(' ');
          else v = cut(v, 100);
          if (!v) return '';
          return ` ${a.name}="${esc(v)}"`;
        })
        .join('');

    const render = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        return t ? esc(cut(t, 160)) : '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      if (DROP.has(tag) || node.getAttribute('role') === 'navigation') return '';

      let inner = '';
      let prevSig = null;
      let run = 0;
      let omitted = 0;
      const flush = () => {
        if (omitted) inner += `<!-- ${omitted} more similar -->`;
        omitted = 0;
      };
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const sig = child.tagName + '.' + child.className;
          if (sig === prevSig) run++;
          else {
            flush();
            prevSig = sig;
            run = 1;
          }
          if (run > KEEP_SIMILAR) {
            omitted++;
            continue;
          }
        }
        inner += render(child);
      }
      flush();

      if (!inner && tag !== 'a' && tag !== 'time') return '';
      return `<${tag}${attrs(node)}>${inner}</${tag}>`;
    };

    return render(document.body);
  });
  return html.length > maxChars ? html.slice(0, maxChars) + '\n<!-- truncated -->' : html;
}
