import { setupFirebase, deviceModel, readReceipt, readStatement, summarise, CATEGORIES } from './ai.js';

const $ = (s) => document.querySelector(s);
const store = {
  get rows() { return JSON.parse(localStorage.getItem('shoebox.rows') || '[]'); },
  set rows(v) { localStorage.setItem('shoebox.rows', JSON.stringify(v)); },
  get stats() { return JSON.parse(localStorage.getItem('shoebox.stats') || '{"on_device":0,"in_cloud":0}'); },
  set stats(v) { localStorage.setItem('shoebox.stats', JSON.stringify(v)); },
};
const LABEL = { on_device: 'On this device', in_cloud: 'Cloud' };
const badge = (src) => `<span class="badge ${src.toUpperCase()}">${LABEL[src] || src}</span>`;
const money = (n, c = 'GBP') => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: c || 'GBP' }).format(n || 0); } catch { return `${(n || 0).toFixed(2)} ${c}`; } };
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/^\s*[*-]\s+/gm, '• ');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function count(src) { const s = store.stats; s[src] = (s[src] || 0) + 1; store.stats = s; meter(); }
function meter() {
  const s = store.stats, total = s.on_device + s.in_cloud;
  $('#meter').classList.toggle('has', total > 0);
  $('#meter-fill').style.width = total ? `${(100 * s.on_device) / total}%` : '0';
  $('#meter-label').textContent = total ? `${Math.round((100 * s.on_device) / total)}% stayed on this device · ${total} requests` : '0 requests yet';
}

function render() {
  const rows = store.rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  $('#ledger-table tbody').innerHTML = rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.merchant)}</td><td>${esc(r.category)}</td><td class="num">${money(r.vat, r.currency)}</td><td class="num">${money(r.total, r.currency)}</td><td>${badge(r.source)}${r.ms ? ` <small style="color:var(--muted)">${(r.ms / 1000).toFixed(1)}s</small>` : ''}</td></tr>`).join('');
  $('#empty').hidden = rows.length > 0;
  const total = rows.reduce((a, r) => a + (+r.total || 0), 0), vat = rows.reduce((a, r) => a + (+r.vat || 0), 0);
  $('#totals').textContent = rows.length ? `${rows.length} items · ${money(total)} · VAT ${money(vat)}` : '';
}

function job(text) {
  const el = document.createElement('div'); el.className = 'job'; el.innerHTML = `<span>${esc(text)}</span><span>working…</span>`;
  $('#queue').append(el);
  return { done: () => el.remove(), fail: (m) => { el.classList.add('err'); el.lastChild.textContent = m; setTimeout(() => el.remove(), 8000); } };
}

async function addReceipts(files) {
  for (const f of files) {
    const j = job(`Reading ${f.name}`);
    try {
      const { data, source, ms } = await readReceipt(f);
      store.rows = [...store.rows, { ...data, category: CATEGORIES.includes(data.category) ? data.category : 'Other', source, ms, kind: 'receipt', id: crypto.randomUUID() }];
      count(source); render(); j.done();
    } catch (e) { console.error(e); j.fail(e.message || 'Could not read it'); }
  }
}

async function addStatement(file) {
  const j = job(`Reading statement ${file.name} (PDF, goes to the cloud)`);
  try {
    const { data, source, ms } = await readStatement(file);
    const have = store.rows.filter((r) => r.kind === 'receipt');
    const dup = (t) => have.some((r) => Math.abs((+r.total || 0) - (+t.total || 0)) < 0.01 && Math.abs(new Date(r.date) - new Date(t.date)) <= 2 * 864e5);
    const biz = data.filter((t) => t.business !== false && !dup(t)).map((t) => ({ ...t, vat: 0, source, ms, kind: 'statement', id: crypto.randomUUID() }));
    store.rows = [...store.rows, ...biz]; count(source); render(); j.done();
  } catch (e) { console.error(e); j.fail(e.message || 'Could not read it'); }
}

async function summary() {
  const rows = store.rows; if (!rows.length) return;
  const by = {}; rows.forEach((r) => { by[r.category] = (by[r.category] || 0) + (+r.total || 0); });
  const sorted = Object.entries(by).sort((a, b) => b[1] - a[1]);
  $('#summary').hidden = false;
  $('#summary-cats').innerHTML = sorted.map(([c, v]) => `<div class="cat"><span>${esc(c)}</span><span class="num">${money(v)}</span></div>`).join('');
  let acc = ''; $('#summary-text').textContent = ''; $('#summary-badge').outerHTML = '<span class="badge" id="summary-badge">thinking…</span>';
  try {
    for await (const c of summarise(sorted.map(([k, v]) => `${k}: £${v.toFixed(2)}`).join('\n'))) {
      acc += c.text; $('#summary-text').innerHTML = md(acc.trim());
      if (c.done) { $('#summary-badge').outerHTML = badge(c.source).replace('class="badge', 'id="summary-badge" class="badge'); count(c.source); }
    }
  } catch (e) { $('#summary-text').textContent = `Could not write the summary: ${e.message}`; }
  $('#summary').scrollIntoView({ behavior: 'smooth' });
}

async function modelStatus() {
  const box = $('#model-status'), txt = $('#model-text'), btn = $('#model-btn');
  if (typeof LanguageModel === 'undefined') { box.className = 'model-status cloud'; txt.textContent = 'No on-device model in this browser: everything runs in the cloud'; return; }
  const a = await LanguageModel.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }] });
  if (a === 'available') { box.className = 'model-status ready'; txt.textContent = 'Gemini Nano ready: receipts stay on this device'; btn.hidden = true; return; }
  if (a === 'unavailable') { box.className = 'model-status cloud'; txt.textContent = 'This device can\'t run Gemini Nano: the cloud takes over'; return; }
  txt.textContent = a === 'downloading' ? 'Gemini Nano downloading… cloud covers you meanwhile' : 'Gemini Nano not downloaded yet: cloud covers you meanwhile';
  btn.hidden = false;
  btn.onclick = async () => {
    btn.disabled = true;
    await deviceModel().initializeDeviceModel((p) => { txt.textContent = `Downloading Gemini Nano… ${Math.round(p * 100)}%`; });
    const poll = setInterval(async () => { if ((await LanguageModel.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }] })) === 'available') { clearInterval(poll); modelStatus(); } }, 3000);
  };
}

function dropzone(label, input, handler) {
  const el = $(label);
  input.addEventListener('change', () => { handler([...input.files]); input.value = ''; });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); handler([...e.dataTransfer.files]); });
}

if (!setupFirebase()) {
  $('#model-text').textContent = 'Setup needed: add the Firebase config in src/firebase-config.js';
} else {
  modelStatus();
}
dropzone('#drop-receipt', $('#receipt-input'), (fs) => addReceipts(fs.filter((f) => /image\/(jpeg|png)/.test(f.type))));
dropzone('#drop-statement', $('#statement-input'), (fs) => fs[0] && addStatement(fs[0]));
$('#summary-btn').onclick = summary;
async function sampleFile(name, type) { const b = await (await fetch(`/samples/${name}`)).blob(); return new File([b], name, { type }); }
$('#sample-btn').onclick = async () => {
  $('#sample-btn').disabled = true;
  const receipts = await Promise.all(['pret.png', 'trainline.png', 'currys.png'].map((n) => sampleFile(n, 'image/png')));
  await addReceipts(receipts);
  await addStatement(await sampleFile('statement.pdf', 'application/pdf'));
  $('#sample-btn').disabled = false;
};
$('#clear-btn').onclick = () => { store.rows = []; store.stats = { on_device: 0, in_cloud: 0 }; render(); meter(); $('#summary').hidden = true; };
render(); meter();
