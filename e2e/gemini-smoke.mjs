// Calls the real Gemini API with the same request shapes the extension uses, to check them.
// Reads the key from e2e/.gemini-key (never printed).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const key = readFileSync(resolve(import.meta.dirname, '.gemini-key'), 'utf8').trim();
if (!key) throw new Error('Paste your Gemini key into e2e/.gemini-key first.');
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest';
const URL_ = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function call(label, body) {
  const t = Date.now();
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  const out = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const grounding = json?.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0;
  console.log(`\n== ${label}: HTTP ${res.status} in ${Date.now() - t} ms${res.ok ? '' : ` | ${json?.error?.status}: ${json?.error?.message?.slice(0, 300)}`}`);
  if (res.ok) console.log(`   grounding sources: ${grounding}\n   answer: ${out.slice(0, 400).replace(/\n/g, ' ')}`);
  return { ok: res.ok, status: res.status, out, json };
}

const strings = { type: 'array', items: { type: 'string' } };
const detectionSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' }, name: { type: 'string' }, brand: { type: 'string' }, concentration: { type: 'string' },
    notes: { type: 'object', properties: { top: strings, heart: strings, base: strings, flat: strings }, required: ['top', 'heart', 'base', 'flat'] },
    currentPrice: { type: 'object', properties: { amountInr: { type: 'number' }, siteName: { type: 'string' } }, required: ['amountInr', 'siteName'] },
  },
  required: ['found', 'name', 'brand', 'concentration', 'notes', 'currentPrice'],
};

// 1. Normal call: JSON mode with a response schema (detection, notes, dupes, price extraction)
const a = await call('1. JSON answer with responseSchema', {
  systemInstruction: { parts: [{ text: 'You identify perfumes. Answer with JSON only.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Page text: Dior Sauvage Eau de Toilette 100ml, Rs. 9,200. Free delivery.\nIs this about a specific perfume? Fill in the JSON.' }] }],
  generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: detectionSchema },
});
if (a.ok) { try { const j = JSON.parse(a.out); console.log('   parsed OK -> name:', j.name, '| brand:', j.brand, '| found:', j.found); } catch { console.log('   !! not valid JSON'); } }

// 2. Grounded call: Google Search tool, JSON in a fenced block (blocked-shop prices, Fragrantica page lookup)
const b = await call('2. Google Search grounding (the blocked-shop fallback)', {
  systemInstruction: { parts: [{ text: 'You find prices. Answer with JSON only.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Find the current price of "Dior Sauvage Eau de Toilette 100ml" on Nykaa (nykaa.com), an Indian online shop. Only use information from nykaa.com.\n\nUse Google Search. Respond with only one JSON object in a ```json fenced block with keys found (boolean), priceInr (number), url (string).' }] }],
  generationConfig: { temperature: 0.2 },
  tools: [{ google_search: {} }],
});
if (b.ok) { const m = /```json\s*([\s\S]*?)```/i.exec(b.out); try { console.log('   fenced JSON parsed ->', JSON.stringify(JSON.parse((m ? m[1] : b.out).trim()))); } catch { console.log('   !! could not parse the JSON from the answer'); } }
