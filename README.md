# Shoebox: private receipts, hybrid AI

**Live demo:** https://flovr-hybridai.web.app (press **Try it with sample data**)

Shoebox reads receipts and bank statements for freelancers and sole traders and builds a tax-year expense ledger.
It uses the **Firebase AI Logic hybrid inference SDK**: each request runs on the device with Gemini Nano when it can,
and falls back to the cloud (Gemini Developer API) when it can't.

| What | Where it runs | Why |
| --- | --- | --- |
| Receipt photos (JPEG/PNG) | On-device, Gemini Nano in Chrome | Private, offline, free. Receipts carry card digits and addresses |
| Bank statements (PDF) | Cloud | PDFs aren't supported on-device, so the SDK routes them to the cloud |
| Tax-year summary | On-device, streaming | Short text over totals |

Every row shows a badge (**On this device** or **Cloud**) from `response.inferenceSource`, and the header meter shows how much stayed on the device.
Statement lines that match a receipt already in the ledger (same amount, within 2 days) are merged, so nothing is counted twice.

## How it uses Firebase AI Logic
- `getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, onDeviceParams, inCloudParams })` in `src/ai.js`
- Structured output on both paths: `responseConstraint` (JSON Schema) on-device, `responseSchema` in the cloud
- `initializeDeviceModel()` with download progress after a user click
- App Check with reCAPTCHA Enterprise on the hosted site, and a debug token only in local dev (`.env.local`, never committed)

## Run it locally
```bash
npm install
cp src/firebase-config.example.js src/firebase-config.js   # paste your Firebase web config
echo "VITE_APPCHECK_DEBUG_TOKEN=<your registered debug token>" > .env.local
npx vite --port 5199
```
Needs Chrome with the built-in Prompt API (Gemini Nano) for the on-device path. Other browsers fall back to the cloud.

## Who built it
Built by Flovr (Volodymyr Romanenko and Alex) with **Zahar, Flovr's AI employee**, which wrote most of the code with AI coding tools. No pre-existing code apart from the open-source libraries in `package.json`.
Sample receipts and the bank statement in `public/samples` are made up for the demo.

Prototype, not tax advice. MIT licence.
