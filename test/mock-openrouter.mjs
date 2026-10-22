// Fake OpenRouter API for testing the LLM flow offline:
//   test/a:free -> 429 with the provider reason in metadata (should be skipped for later feeds)
//   test/b:free -> first a selector matching nothing, then working selectors with a hashed class
//   test/c:free -> stable working selectors
import http from 'node:http';

const free = { prompt: '0', completion: '0' };
const models = [
  { id: 'paid/model', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'test/a:free', context_length: 160000, pricing: free },
  { id: 'test/b:free', context_length: 128000, pricing: free, supported_parameters: ['response_format'] },
  { id: 'test/c:free', context_length: 100000, pricing: free },
];

http
  .createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/models') return json(200, { data: models });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    console.error(`[mock] ${body.model}, ${body.messages.length} messages, html ${body.messages[1].content.length} chars`);

    if (body.model === 'test/a:free') {
      return json(429, {
        error: { message: 'Provider returned error', metadata: { provider_name: 'Fake', raw: 'rate-limited upstream' } },
      });
    }
    const answer =
      body.model === 'test/b:free'
        ? body.messages.length === 2
          ? 'Sure! ```json\n{"item": ".does-not-exist", "title": "h3"}\n```'
          : '<think>hmm</think>{"item": "[class*=\\"AssetItem-module-scss-module__nUeDbq__article\\"], li[data-listing-row]", "title": "h3", "link": null, "date": "time"}'
        : '{"item": "[data-listing-row]", "title": "h3", "link": null, "date": "time", "description": null}';
    json(200, { choices: [{ message: { content: answer } }] });
  })
  .listen(process.env.PORT || 8787);
