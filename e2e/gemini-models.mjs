// Lists the Gemini models this key can call, then tries a tiny JSON call and a grounded call on a few of them.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const key = readFileSync(resolve(import.meta.dirname, '.gemini-key'), 'utf8').trim();
const H = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
const base = 'https://generativelanguage.googleapis.com/v1beta';

const list = await (await fetch(`${base}/models?pageSize=200`, { headers: H })).json();
const models = (list.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((m) => m.name.replace('models/', ''));
console.log('models that support generateContent:', models.length);
console.log(models.filter((n) => /flash|pro|lite/.test(n) && !/image|tts|audio|live|embedding|robotics|computer|thinking-exp|gemma/.test(n)).join('\n'));

const candidates = (process.env.TRY ?? 'gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite').split(',').filter((m) => models.includes(m));
console.log('\nTrying:', candidates.join(', '));
async function go(model, grounded) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: grounded ? 'What is the price of Dior Sauvage EDT 100ml on nykaa.com in INR? Use Google Search. Reply in one short line.' : 'Reply with JSON {"ok": true}' }] }],
    generationConfig: grounded ? { temperature: 0.2 } : { temperature: 0.2, responseMimeType: 'application/json' },
    ...(grounded ? { tools: [{ google_search: {} }] } : {}),
  };
  const t = Date.now();
  const r = await fetch(`${base}/models/${model}:generateContent`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  const retry = JSON.stringify(j).match(/"retryDelay":\s*"([^"]+)"/)?.[1];
  const quotaId = JSON.stringify(j).match(/"quotaId":\s*"([^"]+)"/)?.[1];
  const txt = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').slice(0, 90).replace(/\n/g, ' ');
  return `${r.status} ${Date.now() - t}ms${r.ok ? ` | "${txt}"` : ` | ${j.error?.status} ${j.error?.message?.slice(0, 90).replace(/\n/g, ' ')}${retry ? ` | retry in ${retry}` : ''}${quotaId ? ` | quota: ${quotaId}` : ''}`}`;
}
for (const m of candidates) {
  console.log(`\n${m}\n  JSON     : ${await go(m, false)}\n  grounded : ${await go(m, true)}`);
}
