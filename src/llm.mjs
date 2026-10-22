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
  const errors = [];

  for (const model of models) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Page URL: ${url}\n\nSimplified HTML:\n${html}` },
    ];

    for (let round = 0; round <= repairRounds; round++) {
      let answer;
      try {
        answer = await chat(model, messages);
      } catch (err) {
        // Unavailable, rate-limited or broken model: move on to the next one.
        errors.push(`${model.id}: ${err.message}`);
        log(`  ${model.id}: ${err.message}`);
        break;
      }

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
      if (result.ok) {
        log(`  ${model.id}: selectors accepted (${result.items.length} items)`);
        return { selectors: result.selectors, model: model.id, items: result.items };
      }

      errors.push(`${model.id}: ${result.problem}`);
      log(`  ${model.id}: selectors rejected (${result.problem})`);
      messages.push(
        { role: 'assistant', content: answer },
        {
          role: 'user',
          content:
            `These selectors do not work on the live page: ${result.problem}\n` +
            `First items extracted with them: ${JSON.stringify(result.items.slice(0, 5))}\n` +
            'Fix the selectors. Reply with ONLY the JSON object.',
        },
      );
    }
  }

  throw new Error(`LLM could not find working selectors:\n  ${errors.join('\n  ')}`);
}

// Preferred models from config first, then (by default) whatever free models OpenRouter
// currently lists, largest context first.
async function candidateModels(cfg, htmlChars) {
  const available = await listModels().catch((err) => {
    console.log(`::warning::could not list OpenRouter models: ${err.message}`);
    return null;
  });
  const byId = new Map((available ?? []).map((m) => [m.id, m]));
  const exclude = new Set(cfg.exclude ?? []);
  const minContext = Math.ceil(htmlChars / 3) + 4_000; // rough chars->tokens plus room for the answer

  const preferred = (cfg.models ?? [])
    .filter((id) => !exclude.has(id))
    // Skip preferred models that disappeared from OpenRouter; keep all if the list is unavailable.
    .filter((id) => !available || byId.has(id))
    .map((id) => byId.get(id) ?? { id });

  const free =
    cfg.free_models === false || !available
      ? []
      : available
          .filter((m) => isFree(m) && !exclude.has(m.id) && (m.context_length ?? 0) >= minContext)
          .filter((m) => (m.architecture?.output_modalities ?? ['text']).includes('text'))
          .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));

  const seen = new Set();
  return [...preferred, ...free]
    .filter((m) => !seen.has(m.id) && seen.add(m.id))
    .slice(0, cfg.max_models ?? 5);
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

function isFree(m) {
  return m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
}

async function chat(model, messages) {
  const body = { model: model.id, messages, temperature: 0, max_tokens: 4_000 };
  if (model.supported_parameters?.includes('response_format')) {
    body.response_format = { type: 'json_object' };
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
    throw new Error(`HTTP ${res.status}: ${data.error?.message ?? res.statusText}`);
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
