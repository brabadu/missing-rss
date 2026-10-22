// Asks an LLM on OpenRouter to find CSS selectors for the list of articles on a page.
// Free models come and go, so candidates are resolved at runtime from the OpenRouter model list
// and every answer is validated against the live page before it is accepted.

const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.OPENROUTER_API_KEY;
const REQUEST_TIMEOUT_MS = 180_000;

export const hasLlm = () => Boolean(API_KEY);

const SYSTEM_PROMPT = `You are an expert web scraper. You receive simplified HTML of a web page that lists articles, blog posts, news or similar publications. Find the CSS selectors that extract that list so it can be turned into an RSS feed.

Return ONLY a JSON object, no prose, in exactly this shape:
{"item": "...", "title": "...", "link": "...", "date": "...", "description": "..."}

- "item": selector matching every entry of the MAIN publication list (one element per article), used with document.querySelectorAll. Not navigation, footer, tags or category links.
- "title", "link", "date", "description": selectors RELATIVE to the item element (used with item.querySelector).
- "link" must point to an <a href> of the article. Use null if the item element itself is the <a>.
- "date": the element with the publication date (a <time> element or its text). null if there is no date.
- "description": the short summary/excerpt. null if there is none.
- "title": null only if the item's whole text is the title.
- Prefer stable selectors: tag names, semantic elements, ids, data-* attributes, readable class names. Class names that look auto-generated (hashes like "__nUeDbq__" or "css-1x2y3z") change on every site deploy: avoid them, or match only the readable part with an attribute selector such as [class*="article"].
- Selectors must be valid for document.querySelectorAll. Do not use :contains() or other non-standard pseudo-classes.
- In the HTML, "<!-- N more similar -->" means N more siblings with the same structure were omitted.`;

export async function detectSelectors({ url, html, validate, llmConfig = {}, log = console.log }) {
  if (!API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

  const models = await candidateModels(llmConfig, html.length);
  if (models.length === 0) throw new Error('no LLM models available');

  const repairRounds = llmConfig.repair_rounds ?? 1;
  const maxModels = llmConfig.max_models ?? 5;
  const errors = [];
  let answered = 0;
  // Working selectors that use auto-generated class names: used only if nothing better turns up.
  let fallback = null;

  for (const model of models) {
    if (deadModels.has(model.id)) continue;
    if (answered >= maxModels) break;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Page URL: ${url}\n\nSimplified HTML:\n${html}` },
    ];

    for (let round = 0; round <= repairRounds; round++) {
      let answer;
      try {
        answer = await chat(model, messages);
      } catch (err) {
        // Unavailable, rate-limited or broken model: move on to the next one, and don't
        // waste requests on it for the other feeds in this run.
        deadModels.add(model.id);
        errors.push(`${model.id}: ${err.message}`);
        log(`  ${model.id}: ${err.message}`);
        break;
      }
      if (round === 0) answered++;

      let selectors;
      try {
        selectors = normalizeSelectors(parseJson(answer));
      } catch (err) {
        errors.push(`${model.id}: ${err.message}`);
        log(`  ${model.id}: unusable answer (${err.message})`);
        messages.push(
          { role: 'assistant', content: answer },
          { role: 'user', content: `Your answer could not be used: ${err.message}. Reply with ONLY the JSON object.` },
        );
        continue;
      }

      const result = await validate(selectors);
      const hashed = result.ok && hashedSelector(result.selectors);
      if (result.ok && !hashed) {
        log(`  ${model.id}: selectors accepted (${result.items.length} items)`);
        return { selectors: result.selectors, model: model.id, items: result.items };
      }

      let problem;
      if (hashed) {
        fallback ??= { selectors: result.selectors, model: model.id, items: result.items };
        problem = `"${hashed[0]}" selector "${hashed[1]}" uses an auto-generated class name that changes on every site deploy`;
        errors.push(`${model.id}: ${problem}`);
        log(`  ${model.id}: selectors work but are fragile (${problem})`);
      } else {
        problem = `these selectors do not work on the live page: ${result.problem}`;
        errors.push(`${model.id}: ${result.problem}`);
        log(`  ${model.id}: selectors rejected (${result.problem})`);
      }
      messages.push(
        { role: 'assistant', content: answer },
        {
          role: 'user',
          content:
            `Problem: ${problem}\n` +
            `First items extracted with them: ${JSON.stringify(result.items.slice(0, 5))}\n` +
            'Fix the selectors. Reply with ONLY the JSON object.',
        },
      );
    }
  }

  if (fallback) {
    log(`  using fragile selectors from ${fallback.model}: no model found stable ones`);
    return fallback;
  }
  throw new Error(`LLM could not find working selectors:\n  ${errors.join('\n  ')}`);
}

// Models that errored once are skipped for the rest of the run (other feeds included):
// e.g. models gated to specific apps answer 403 every time, rate limits don't clear in minutes.
const deadModels = new Set();

// Class names generated by CSS modules (Foo-module__a1B2c__title; the hash has an uppercase
// letter or digit, which tells it apart from BEM's block__element__x), emotion (css-1x2y3z),
// styled-components (sc-AbCdE) and styled-jsx (jsx-123).
const HASHED_CLASS = /__(?=[a-z-]*[A-Z0-9])[A-Za-z0-9-]{5,8}__|\bcss-[a-z0-9]{5,}\b|\bsc-(?=[a-z]*[A-Z])[A-Za-z]{5,}\b|\bjsx-\d+\b/;

function hashedSelector(sel) {
  for (const key of ['item', 'title', 'link', 'date', 'description']) {
    if (sel[key] && HASHED_CLASS.test(sel[key])) return [key, sel[key]];
  }
  return null;
}

// Preferred models from config first, then (by default) whatever free models OpenRouter
// currently lists: benchmarked ones by score, then the rest, then the openrouter/free router.
async function candidateModels(cfg, htmlChars) {
  const available = await listModels().catch((err) => {
    console.log(`::warning::could not list OpenRouter models: ${err.message}`);
    return null;
  });
  const byId = new Map((available ?? []).map((m) => [m.id, m]));
  const excluded = excludeMatcher(cfg.exclude);
  const minContext = Math.ceil(htmlChars / 3) + 4_000; // rough chars->tokens plus room for the answer

  const preferred = (cfg.models ?? [])
    .filter((id) => !excluded(id))
    // Skip preferred models that disappeared from OpenRouter; keep all if the list is unavailable.
    .filter((id) => !available || byId.has(id))
    .map((id) => byId.get(id) ?? { id });

  const free =
    cfg.free_models === false || !available
      ? []
      : available
          .filter((m) => isFree(m) && !excluded(m.id) && (m.context_length ?? 0) >= minContext)
          // Text-only output: skips music/image generators. Guard models only classify.
          .filter((m) => (m.architecture?.output_modalities ?? ['text']).join() === 'text')
          .filter((m) => !/guard|safety|moderat/i.test(m.id))
          .sort((a, b) => rank(b) - rank(a) || (b.context_length ?? 0) - (a.context_length ?? 0));

  // No cap here: max_models limits models that actually answer, see detectSelectors.
  const seen = new Set();
  return [...preferred, ...free].filter((m) => !seen.has(m.id) && seen.add(m.id));
}

// Exclude entries are model ids, "*" matches any characters: "thinkingmachines/inkling*".
function excludeMatcher(patterns) {
  const regexes = (patterns ?? []).map(
    (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`),
  );
  return (id) => regexes.some((re) => re.test(id));
}

let modelsCache;
async function listModels() {
  modelsCache ??= (async () => {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).data ?? [];
  })();
  return modelsCache;
}

// Artificial Analysis indexes from the OpenRouter model list; unbenchmarked models go after
// benchmarked ones, and the random free-model router goes last.
function rank(m) {
  if (m.id === 'openrouter/free') return -2;
  const aa = m.benchmarks?.artificial_analysis;
  if (!aa || (aa.coding_index == null && aa.intelligence_index == null)) return -1;
  return (aa.coding_index ?? 0) + (aa.intelligence_index ?? 0);
}

function isFree(m) {
  return m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
}

async function chat(model, messages) {
  // Generous max_tokens: for reasoning models the thinking counts against it too.
  const body = { model: model.id, messages, temperature: 0, max_tokens: 16_000 };
  if (model.supported_parameters?.includes('response_format')) {
    body.response_format = { type: 'json_object' };
  }
  if (model.supported_parameters?.includes('reasoning')) {
    body.reasoning = { effort: 'low', exclude: true };
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/brabadu/missing-rss',
      'X-Title': 'missing-rss',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    // OpenRouter often says just "Provider returned error"; the provider's reason is in metadata.
    const meta = data.error?.metadata ?? {};
    const detail = [meta.provider_name, meta.raw && String(meta.raw).slice(0, 200)].filter(Boolean).join(': ');
    throw new Error(`HTTP ${res.status}: ${data.error?.message ?? res.statusText}${detail ? ` (${detail})` : ''}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error('empty response');
  return content;
}

// Models wrap JSON in prose, code fences or <think> blocks; dig the object out.
export function parseJson(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeSelectors(obj) {
  const clean = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim() : null);
  const sel = {
    item: clean(obj.item),
    title: clean(obj.title),
    link: clean(obj.link),
    date: clean(obj.date),
    description: clean(obj.description),
  };
  if (!sel.item) throw new Error('"item" selector is missing');
  return sel;
}
