// Fake OpenRouter API for testing the LLM flow offline:
//   model a:free -> 429 rate limit
//   model b:free -> first a selector matching nothing, then (repair round) working selectors
import http from 'node:http';

const models = [
  { id: 'paid/model', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'test/a:free', context_length: 160000, pricing: { prompt: '0', completion: '0' } },
  { id: 'test/b:free', context_length: 128000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['response_format'] },
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
    if (body.model === 'test/a:free') return json(429, { error: { message: 'Rate limit exceeded' } });
    const answer =
      body.messages.length === 2
        ? 'Sure! ```json\n{"item": ".does-not-exist", "title": "h3"}\n```'
        : '<think>hmm</think>{"item": "article[data-listing-row]", "title": "h3", "link": "h3 a", "date": "time", "description": null}';
    json(200, { choices: [{ message: { content: answer } }] });
  })
  .listen(process.env.PORT || 8787);
