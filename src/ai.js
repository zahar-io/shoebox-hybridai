// Hybrid AI layer: Firebase AI Logic decides per request whether Gemini Nano (on-device) or the cloud model runs it.
import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from 'firebase/ai';
import { firebaseConfig, recaptchaSiteKey } from './firebase-config.js';

export const CATEGORIES = ['Travel', 'Meals', 'Office & software', 'Equipment', 'Phone & internet', 'Training', 'Marketing', 'Other'];

let ai = null;
export function setupFirebase() {
  if (!firebaseConfig?.apiKey) return false;
  const app = initializeApp(firebaseConfig);
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (recaptchaSiteKey || local) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey || 'debug-only'), isTokenAutoRefreshEnabled: true });
  ai = getAI(app, { backend: new GoogleAIBackend() });
  return true;
}

const receiptJson = {
  type: 'object',
  properties: {
    merchant: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    total: { type: 'number' },
    vat: { type: 'number' },
    currency: { type: 'string', description: 'ISO code, e.g. GBP' },
    category: { type: 'string', enum: CATEGORIES },
  },
  required: ['merchant', 'date', 'total', 'vat', 'currency', 'category'],
};
const receiptSchema = Schema.object({
  properties: {
    merchant: Schema.string(), date: Schema.string(), total: Schema.number(), vat: Schema.number(),
    currency: Schema.string(), category: Schema.enumString({ enum: CATEGORIES }),
  },
});
const statementSchema = Schema.object({
  properties: {
    transactions: Schema.array({ items: Schema.object({ properties: {
      date: Schema.string(), merchant: Schema.string(), total: Schema.number(), currency: Schema.string(),
      category: Schema.enumString({ enum: CATEGORIES }), business: Schema.boolean(),
    } }) }),
  },
});

const RECEIPT_PROMPT = `Read this receipt. Return the merchant, the date (YYYY-MM-DD), the total paid, the VAT amount (0 if none shown) and the currency code. Pick the closest category from: ${CATEGORIES.join(', ')}. Only use what is printed on the receipt.`;
const STATEMENT_PROMPT = `This is a bank statement. List every outgoing payment as a transaction (date YYYY-MM-DD, merchant, amount as a positive number, currency code, category from: ${CATEGORIES.join(', ')}). Set business to true when it looks like a business expense for a freelancer. Skip incoming payments and transfers between own accounts.`;

let receiptModel, statementModel, summaryModel;
function models() {
  if (receiptModel) return;
  receiptModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: { expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: [{ type: 'text', languages: ['en'] }] },
      promptOptions: { responseConstraint: receiptJson },
    },
    inCloudParams: { generationConfig: { responseMimeType: 'application/json', responseSchema: receiptSchema, temperature: 0 } },
  });
  // PDFs can't run on-device, so hybrid routing sends statements to the cloud by design.
  statementModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: { generationConfig: { responseMimeType: 'application/json', responseSchema: statementSchema, temperature: 0 } },
  });
  summaryModel = getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE });
}

export function deviceModel() { models(); return receiptModel; }

async function filePart(file) {
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
  return { inlineData: { data: b64, mimeType: file.type } };
}

function parseJson(text) {
  const t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '');
  return JSON.parse(t);
}

export async function readReceipt(file) {
  models();
  const t0 = performance.now();
  const r = await receiptModel.generateContent([RECEIPT_PROMPT, await filePart(file)]);
  return { data: parseJson(r.response.text()), source: r.response.inferenceSource || 'in_cloud', ms: Math.round(performance.now() - t0) };
}

export async function readStatement(file) {
  models();
  const t0 = performance.now();
  const r = await statementModel.generateContent([STATEMENT_PROMPT, await filePart(file)]);
  return { data: parseJson(r.response.text()).transactions || [], source: r.response.inferenceSource || 'in_cloud', ms: Math.round(performance.now() - t0) };
}

export async function* summarise(lines) {
  models();
  const prompt = `You help a UK freelancer before self-assessment. Here are their categorised expense totals for the tax year:\n${lines}\nWrite 3 short bullet points: what stands out, anything that looks unusual, and one tip to keep better records. Plain English, no tax advice, under 90 words.`;
  const r = await summaryModel.generateContentStream(prompt);
  let first = true;
  for await (const chunk of r.stream) { yield { text: chunk.text(), source: first ? (chunk.inferenceSource || null) : null }; first = false; }
  const final = await r.response; yield { text: '', source: final.inferenceSource || 'in_cloud', done: true };
}
