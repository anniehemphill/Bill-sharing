import { computeSplit, fmt, toCents, parseReceipt, splitUnits } from './split.js';

// ---------- state ----------
const KEY = 'splitit:v1';
const uid = () => Math.random().toString(36).slice(2, 10);
const ME = 'me';

const defaults = () => ({
  friends: [],
  settings: { myName: 'Me', myPhone: '', currency: 'R', countryCode: '27', defaultTip: 10, payDetails: '' },
  bill: null,
  history: [],
});

let state;
try { state = { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
catch { state = defaults(); }
state.settings = { ...defaults().settings, ...state.settings };

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

let tab = 'bill';
let claimer = ME;      // person currently picking items
let ocr = null;        // {pct, status} while scanning
let openPerson = null; // expanded breakdown on pay screen

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => fmt(c, state.settings.currency);
const cents2str = (c) => (c / 100).toFixed(2);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

function intlNumber(phone) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return state.settings.countryCode + d.slice(1);
  return d;
}

const people = () => state.bill?.people || [];
const personName = (id) => people().find((p) => p.id === id)?.name || '?';

function newBill() {
  const s = state.settings;
  state.bill = {
    id: uid(),
    created: Date.now(),
    place: '',
    items: [],
    people: [{ id: ME, name: s.myName || 'Me', phone: s.myPhone, tipPct: null, paid: true }],
    tipPct: Number(s.defaultTip) || 0,
    detectedTotal: null,
    step: 'items',
  };
  claimer = ME;
  save();
}

// ---------- rendering ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const back = $('#back');
  back.hidden = true;
  let html = '';
  if (tab === 'friends') { $('#title').textContent = 'Friends'; html = viewFriends(); }
  else if (tab === 'settings') { $('#title').textContent = 'Settings'; html = viewSettings(); }
  else if (!state.bill) { $('#title').textContent = 'SplitIt'; html = viewStart(); }
  else {
    $('#title').textContent = state.bill.place || 'New bill';
    const steps = ['items', 'people', 'claim', 'pay'];
    const i = steps.indexOf(state.bill.step);
    back.hidden = i <= 0;
    html = viewSteps() + { items: viewItems, people: viewPeople, claim: viewClaim, pay: viewPay }[state.bill.step]();
  }
  $('#view').innerHTML = html;
}

function viewStart() {
  const hist = state.history.slice(0, 10).map((b) => {
    const r = computeSplit(b);
    const unpaid = b.people.filter((p) => !p.paid).length;
    return `<li><div class="grow"><div class="name">${esc(b.place || 'Bill')}</div>
      <div class="muted">${new Date(b.created).toLocaleDateString()} · ${b.people.length} people${unpaid ? ` · ${unpaid} unpaid` : ''}</div></div>
      <span class="amt">${money(r.grandTotal)}</span>
      <button class="btn small" data-act="reopen" data-id="${b.id}">Open</button></li>`;
  }).join('');
  return `
    <div class="card">
      <h2>Split a bill</h2>
      <p class="muted">Scan the bill, add who's at the table, everyone ticks what they had, and the app works out each person's share and tip.</p>
      <button class="btn primary block" data-act="new">Start a new bill</button>
    </div>
    ${hist ? `<h3>Recent bills</h3><div class="card"><ul class="list">${hist}</ul></div>` : ''}`;
}

function viewSteps() {
  const labels = { items: '1 · Items', people: '2 · People', claim: '3 · Who had what', pay: '4 · Tip & pay' };
  return `<div class="steps">${Object.entries(labels).map(([k, l]) =>
    `<button class="${state.bill.step === k ? 'on' : ''}" data-act="step" data-step="${k}">${l}</button>`).join('')}</div>`;
}

function viewItems() {
  const b = state.bill;
  const total = b.items.reduce((a, it) => a + it.price, 0);
  const diff = b.detectedTotal != null ? b.detectedTotal - total : 0;
  const rows = b.items.map((it) => `
    <li>
      <input class="grow" data-edit="name" data-id="${it.id}" value="${esc(it.name)}" aria-label="Item name">
      <input style="width:96px" inputmode="decimal" data-edit="price" data-id="${it.id}" value="${cents2str(it.price)}" aria-label="Price">
      ${it.qty > 1 ? `<button class="btn small" data-act="units" data-id="${it.id}" title="Split into ${it.qty} separate items">÷${it.qty}</button>` : ''}
      <button class="btn small danger" data-act="del-item" data-id="${it.id}" aria-label="Remove">✕</button>
    </li>`).join('');
  return `
    <div class="card">
      <label for="place">Restaurant</label>
      <input id="place" data-edit="place" placeholder="e.g. The Pot Luck Club" value="${esc(b.place)}">
    </div>
    <div class="card">
      <div class="row between"><strong>Scan the bill</strong>
        <label class="btn small primary" style="margin:0;color:var(--accent-ink)">📷 Scan
          <input id="scan" type="file" accept="image/*" capture="environment" hidden>
        </label>
      </div>
      ${ocr ? `<p class="muted">${esc(ocr.status)}</p><div class="progress"><div style="width:${Math.round(ocr.pct * 100)}%"></div></div>`
            : `<p class="muted">Take a clear, flat photo in good light. You can fix any line it gets wrong below.</p>`}
    </div>
    ${b.detectedTotal != null && diff !== 0 ? `<div class="banner">Bill total on the slip is ${money(b.detectedTotal)}, items below add up to ${money(total)} (${diff > 0 ? 'missing' : 'extra'} ${money(Math.abs(diff))}). Check for a missed or misread line.</div>` : ''}
    <div class="card">
      <div class="row between"><strong>Items (${b.items.length})</strong><span class="amt">${money(total)}</span></div>
      ${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">No items yet. Scan the bill or add them below.</p>'}
      <form id="add-item" class="row" style="margin-top:10px">
        <input class="grow" name="name" placeholder="Item" required>
        <input style="width:96px" name="price" inputmode="decimal" placeholder="0.00" required>
        <button class="btn small primary">Add</button>
      </form>
      ${b.items.length ? '<button class="btn small danger" style="margin-top:12px" data-act="clear-items">Clear all items</button>' : ''}
    </div>
    <button class="btn primary block" data-act="step" data-step="people" ${b.items.length ? '' : 'disabled'}>Next: who's here →</button>`;
}

function viewPeople() {
  const b = state.bill;
  const inBill = new Set(b.people.map((p) => p.friendId).filter(Boolean));
  const chips = state.friends.map((f) =>
    `<button class="chip ${inBill.has(f.id) ? 'on' : ''}" data-act="toggle-friend" data-id="${f.id}">${esc(f.name)}</button>`).join('');
  const list = b.people.map((p) => `
    <li><div class="grow"><div class="name">${esc(p.name)}${p.id === ME ? ' <span class="muted">(you, paying the restaurant)</span>' : ''}</div>
      ${p.phone ? `<div class="muted">${esc(p.phone)}</div>` : ''}</div>
      ${p.id === ME ? '' : `<button class="btn small danger" data-act="del-person" data-id="${p.id}" aria-label="Remove">✕</button>`}</li>`).join('');
  return `
    <div class="card">
      <strong>Tap friends to add them</strong>
      ${chips ? `<div class="chips" style="flex-wrap:wrap">${chips}</div>` : '<p class="muted">No saved friends yet. Add someone below — tick “save” to keep them for next time.</p>'}
    </div>
    <div class="card">
      <strong>Add someone new</strong>
      <form id="add-guest">
        <label>Name</label><input name="name" required autocomplete="off">
        <label>Mobile number</label><input name="phone" type="tel" placeholder="082 123 4567" autocomplete="off">
        <label class="row" style="color:var(--text)"><input type="checkbox" name="keep" checked style="width:auto"> Save to my friends</label>
        <button class="btn primary block">Add to bill</button>
      </form>
    </div>
    <div class="card"><strong>At the table (${b.people.length})</strong><ul class="list">${list}</ul></div>
    <button class="btn primary block" data-act="step" data-step="claim" ${b.people.length > 1 ? '' : 'disabled'}>Next: who had what →</button>`;
}

function viewClaim() {
  const b = state.bill;
  if (!b.people.some((p) => p.id === claimer)) claimer = ME;
  const r = computeSplit(b);
  const mine = r.people.find((p) => p.id === claimer);
  const chips = b.people.map((p) =>
    `<button class="chip ${p.id === claimer ? 'on' : ''}" data-act="claimer" data-id="${p.id}">${esc(p.name)}</button>`).join('');
  const rows = b.items.map((it) => {
    const has = it.claims.includes(claimer);
    const who = it.claims.map(personName);
    return `<li class="item ${has ? 'mine' : ''}" data-act="claim" data-id="${it.id}">
      <span class="check">${has ? '✓' : ''}</span>
      <div class="grow"><div class="name">${esc(it.name)}</div>
        <div class="who">${who.length ? (who.length > 1 ? `Shared: ${esc(who.join(', '))}` : esc(who[0])) : 'Not claimed yet'}</div></div>
      <span class="amt">${money(it.price)}</span></li>`;
  }).join('');
  return `
    <p class="muted">Pass the phone round. Each person taps their name, then taps everything they had. Tap one item for several people to share it equally.</p>
    <div class="chips">${chips}</div>
    ${r.unclaimed ? `<div class="banner">${r.unclaimedItems.length} item(s) not claimed yet (${money(r.unclaimed)}).
      <button class="btn small" style="margin-top:6px" data-act="share-rest">Split unclaimed equally between everyone</button></div>` : ''}
    <div class="card"><ul class="list">${rows}</ul></div>
    <div class="card row between"><span><strong>${esc(mine?.name)}</strong> so far</span><span class="amt total-big">${money(mine?.subtotal || 0)}</span></div>
    <button class="btn primary block" data-act="step" data-step="pay">Next: tip &amp; pay →</button>`;
}

function viewPay() {
  const b = state.bill;
  const r = computeSplit(b);
  const tips = [0, 10, 12.5, 15, 20];
  const custom = !tips.includes(b.tipPct);
  const cards = r.people.map((p) => {
    const person = b.people.find((x) => x.id === p.id);
    const isMe = p.id === ME;
    const open = openPerson === p.id;
    const overrideOpts = ['', ...tips].map((t) =>
      `<option value="${t}" ${String(person.tipPct ?? '') === String(t) ? 'selected' : ''}>${t === '' ? `Bill tip (${b.tipPct}%)` : `${t}%`}</option>`).join('');
    return `<div class="card">
      <div class="row between">
        <div><strong>${esc(p.name)}</strong>${isMe ? ' <span class="muted">(you)</span>' : ''}<br>
          <span class="muted">Food ${money(p.subtotal)} + tip ${money(p.tip)} (${p.tipPct}%)</span></div>
        <span class="amt total-big">${money(p.total)}</span>
      </div>
      <details ${open ? 'open' : ''} data-person="${p.id}"><summary>Breakdown &amp; tip</summary>
        <ul class="list">${p.lines.map((l) => `<li><span class="grow name">${esc(l.name)}${l.splitWith > 1 ? ` <span class="muted">(÷${l.splitWith})</span>` : ''}</span><span class="amt">${money(l.share)}</span></li>`).join('') || '<li class="muted">Nothing claimed</li>'}</ul>
        <label>Tip for ${esc(p.name)}</label>
        <select data-edit="ptip" data-id="${p.id}">${overrideOpts}</select>
      </details>
      ${isMe ? '' : `<div class="btn-row" style="margin-top:10px">
        <button class="btn small" data-act="wa" data-id="${p.id}" ${person.phone ? '' : 'disabled'}>WhatsApp</button>
        <button class="btn small" data-act="sms" data-id="${p.id}" ${person.phone ? '' : 'disabled'}>SMS</button>
        <button class="btn small ${person.paid ? '' : 'primary'}" data-act="paid" data-id="${p.id}">${person.paid ? '<span class="paid">✓ Paid</span>' : 'Mark paid'}</button>
      </div>${person.phone ? '' : '<p class="muted">No number saved — add one in People to send a request.</p>'}`}
    </div>`;
  }).join('');
  const owed = r.people.filter((p) => p.id !== ME && !b.people.find((x) => x.id === p.id).paid).reduce((a, p) => a + p.total, 0);
  return `
    ${r.unclaimed ? `<div class="banner">${money(r.unclaimed)} of items isn't claimed by anyone, so it's not in anyone's total. Go back to step 3 to sort it.</div>` : ''}
    <div class="card">
      <strong>Tip</strong>
      <div class="chips" style="flex-wrap:wrap">
        ${tips.map((t) => `<button class="chip ${b.tipPct === t ? 'on' : ''}" data-act="tip" data-tip="${t}">${t}%</button>`).join('')}
        <input style="width:90px" inputmode="decimal" data-edit="tip" placeholder="Other %" value="${custom ? b.tipPct : ''}" aria-label="Custom tip percent">
      </div>
      <p class="muted">Each person tips on what they ordered. Change one person's tip under their breakdown. If the bill already includes a service charge, choose 0%.</p>
    </div>
    ${cards}
    <div class="card">
      <div class="row between"><span>Items</span><span class="amt">${money(r.itemsTotal)}</span></div>
      <div class="row between"><span>Tips</span><span class="amt">${money(r.tipTotal)}</span></div>
      <div class="row between" style="margin-top:6px"><strong>Pay the restaurant (incl. tip)</strong><span class="amt total-big">${money(r.grandTotal)}</span></div>
      <div class="row between"><span class="muted">Still owed to you</span><span class="amt">${money(owed)}</span></div>
    </div>
    <div class="btn-row">
      <button class="btn" data-act="copy">Copy summary</button>
      <button class="btn primary" data-act="finish">Finish &amp; save</button>
    </div>`;
}

function viewFriends() {
  const supportsPicker = 'contacts' in navigator && 'select' in navigator.contacts;
  const rows = state.friends.map((f) => `
    <li><div class="grow"><div class="name">${esc(f.name)}</div><div class="muted">${esc(f.phone || 'No number')}</div></div>
      <button class="btn small danger" data-act="del-friend" data-id="${f.id}" aria-label="Delete">✕</button></li>`).join('');
  return `
    <div class="card">
      <strong>Add a friend</strong>
      <form id="add-friend">
        <label>Name</label><input name="name" required autocomplete="off">
        <label>Mobile number</label><input name="phone" type="tel" placeholder="082 123 4567" autocomplete="off">
        <button class="btn primary block">Save friend</button>
      </form>
      ${supportsPicker ? '<button class="btn block" data-act="pick-contact">Choose from contacts</button>' : ''}
    </div>
    <div class="card">${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">No friends saved yet.</p>'}</div>`;
}

function viewSettings() {
  const s = state.settings;
  return `
    <div class="card">
      <label>Your name</label><input data-set="myName" value="${esc(s.myName)}">
      <label>Currency symbol</label><input data-set="currency" value="${esc(s.currency)}" style="width:90px">
      <label>Country dialling code (for numbers starting with 0)</label><input data-set="countryCode" inputmode="numeric" value="${esc(s.countryCode)}" style="width:90px">
      <label>Default tip %</label><input data-set="defaultTip" inputmode="decimal" value="${esc(s.defaultTip)}" style="width:90px">
      <label>How friends should pay you (added to every request)</label>
      <input data-set="payDetails" placeholder="e.g. FNB 62xxxxxxx, ref: your name — or a SnapScan / payment link" value="${esc(s.payDetails)}">
    </div>
    <p class="muted">Everything is stored only on this phone. Nothing is sent anywhere unless you tap WhatsApp or SMS.</p>
    <button class="btn danger block" data-act="wipe">Delete all data</button>`;
}

// ---------- messages ----------
function requestText(id) {
  const b = state.bill;
  const p = computeSplit(b).people.find((x) => x.id === id);
  const lines = p.lines.map((l) => `• ${l.name}${l.splitWith > 1 ? ` (shared ÷${l.splitWith})` : ''}: ${money(l.share)}`).join('\n');
  const pay = state.settings.payDetails ? `\n\nPay to: ${state.settings.payDetails}` : '';
  return `Hi ${p.name}, here's your share${b.place ? ` from ${b.place}` : ''}:\n${lines}\nFood: ${money(p.subtotal)}\nTip (${p.tipPct}%): ${money(p.tip)}\nTotal: ${money(p.total)}${pay}\n\nThanks! — ${state.settings.myName}`;
}

function summaryText() {
  const b = state.bill;
  const r = computeSplit(b);
  return `${b.place || 'Bill'} — ${new Date(b.created).toLocaleDateString()}\n` +
    r.people.map((p) => `${p.name}: ${money(p.total)} (food ${money(p.subtotal)} + tip ${money(p.tip)})`).join('\n') +
    `\nTotal incl. tip: ${money(r.grandTotal)}`;
}

// ---------- OCR ----------
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESSERACT;
    s.onload = () => res(window.Tesseract);
    s.onerror = () => rej(new Error('Could not load the scanner. Are you online?'));
    document.head.appendChild(s);
  });
}

// Downscale + greyscale + contrast stretch: faster and more accurate on phone photos.
async function prepImage(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = g;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    const g = ((px[i] - lo) * 255) / span;
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

async function scan(file) {
  ocr = { pct: 0, status: 'Loading scanner…' };
  render();
  try {
    const T = await loadTesseract();
    const canvas = await prepImage(file);
    const { data } = await T.recognize(canvas, 'eng', {
      logger: (m) => {
        ocr = { pct: m.progress || 0, status: m.status === 'recognizing text' ? 'Reading the bill…' : 'Preparing…' };
        const bar = $('.progress > div');
        if (bar) bar.style.width = `${Math.round(ocr.pct * 100)}%`;
      },
    });
    const { items, detectedTotal } = parseReceipt(data.text);
    const b = state.bill;
    b.items.push(...items.map((it) => ({ ...it, id: uid(), claims: [] })));
    if (detectedTotal != null) b.detectedTotal = detectedTotal;
    save();
    ocr = null;
    render();
    toast(items.length ? `Found ${items.length} items — check them` : "Couldn't read any items. Try a closer photo or type them in.");
  } catch (e) {
    ocr = null;
    render();
    toast(e.message || 'Scan failed');
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); scrollTo(0, 0); return; }
  if (e.target.closest('#back')) {
    const steps = ['items', 'people', 'claim', 'pay'];
    state.bill.step = steps[Math.max(0, steps.indexOf(state.bill.step) - 1)];
    save(); render(); return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const b = state.bill;
  switch (act) {
    case 'new': newBill(); break;
    case 'step': b.step = el.dataset.step; scrollTo(0, 0); break;
    case 'del-item': b.items = b.items.filter((i) => i.id !== id); break;
    case 'clear-items': if (!confirm('Remove all items?')) return; b.items = []; b.detectedTotal = null; break;
    case 'units': {
      const at = b.items.findIndex((i) => i.id === id);
      const units = splitUnits(b.items[at]).map((u) => ({ ...u, id: uid(), claims: [] }));
      b.items.splice(at, 1, ...units);
      break;
    }
    case 'toggle-friend': {
      const f = state.friends.find((x) => x.id === id);
      const existing = b.people.find((p) => p.friendId === id);
      if (existing) removePerson(existing.id);
      else b.people.push({ id: uid(), friendId: f.id, name: f.name, phone: f.phone, tipPct: null, paid: false });
      break;
    }
    case 'del-person': removePerson(id); break;
    case 'claimer': claimer = id; break;
    case 'claim': {
      const it = b.items.find((i) => i.id === id);
      it.claims = it.claims.includes(claimer) ? it.claims.filter((c) => c !== claimer) : [...it.claims, claimer];
      break;
    }
    case 'share-rest': {
      const all = b.people.map((p) => p.id);
      b.items.forEach((it) => { if (!it.claims.length) it.claims = [...all]; });
      break;
    }
    case 'tip': b.tipPct = Number(el.dataset.tip); break;
    case 'paid': { const p = b.people.find((x) => x.id === id); p.paid = !p.paid; break; }
    case 'wa': {
      const p = b.people.find((x) => x.id === id);
      window.open(`https://wa.me/${intlNumber(p.phone)}?text=${encodeURIComponent(requestText(id))}`, '_blank');
      return;
    }
    case 'sms': {
      const p = b.people.find((x) => x.id === id);
      location.href = `sms:${intlNumber(p.phone) ? '+' + intlNumber(p.phone) : ''}${isIOS ? '&' : '?'}body=${encodeURIComponent(requestText(id))}`;
      return;
    }
    case 'copy':
      try { await navigator.clipboard.writeText(summaryText()); toast('Summary copied'); }
      catch { toast("Couldn't copy"); }
      return;
    case 'finish':
      state.history = [b, ...state.history.filter((h) => h.id !== b.id)].slice(0, 30);
      state.bill = null;
      toast('Bill saved');
      break;
    case 'reopen': {
      const h = state.history.find((x) => x.id === id);
      state.bill = h; h.step = 'pay';
      break;
    }
    case 'del-friend': state.friends = state.friends.filter((f) => f.id !== id); break;
    case 'pick-contact': {
      try {
        const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
        picked.forEach((c) => state.friends.push({ id: uid(), name: c.name?.[0] || 'Friend', phone: c.tel?.[0] || '' }));
      } catch { return; }
      break;
    }
    case 'wipe':
      if (!confirm('Delete all friends, bills and settings from this phone?')) return;
      state = defaults();
      break;
    default: return;
  }
  save();
  render();
});

function removePerson(id) {
  const b = state.bill;
  b.people = b.people.filter((p) => p.id !== id);
  b.items.forEach((it) => { it.claims = it.claims.filter((c) => c !== id); });
}

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const data = Object.fromEntries(new FormData(f));
  const name = String(data.name || '').trim();
  if (f.id === 'add-item') {
    const price = toCents(data.price);
    if (!name || !price) return toast('Enter a name and price');
    state.bill.items.push({ id: uid(), name, price, qty: 1, claims: [] });
  } else if (f.id === 'add-guest') {
    if (!name) return;
    const phone = String(data.phone || '').trim();
    let friendId;
    if (data.keep) { friendId = uid(); state.friends.push({ id: friendId, name, phone }); }
    state.bill.people.push({ id: uid(), friendId, name, phone, tipPct: null, paid: false });
  } else if (f.id === 'add-friend') {
    if (!name) return;
    state.friends.push({ id: uid(), name, phone: String(data.phone || '').trim() });
    toast(`${name} saved`);
  } else return;
  save();
  render();
  const first = $(`#${f.id} input`);
  if (first) first.focus();
});

// Edits save on change (so typing doesn't re-render and drop focus).
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'scan' && el.files?.[0]) { scan(el.files[0]); el.value = ''; return; }
  const b = state.bill;
  if (el.dataset.set) {
    const k = el.dataset.set;
    state.settings[k] = k === 'defaultTip' ? Number(el.value) || 0 : el.value.trim();
    if (k === 'myName' && b) b.people.find((p) => p.id === ME).name = state.settings.myName || 'Me';
    save();
    return;
  }
  const kind = el.dataset.edit;
  if (!kind) return;
  if (kind === 'place') { b.place = el.value.trim(); save(); $('#title').textContent = b.place || 'New bill'; return; }
  if (kind === 'name' || kind === 'price') {
    const it = b.items.find((i) => i.id === el.dataset.id);
    if (kind === 'name') it.name = el.value.trim() || it.name;
    else it.price = toCents(el.value);
  } else if (kind === 'tip') {
    const v = parseFloat(el.value.replace(',', '.'));
    if (Number.isFinite(v) && v >= 0) b.tipPct = v;
  } else if (kind === 'ptip') {
    const p = b.people.find((x) => x.id === el.dataset.id);
    p.tipPct = el.value === '' ? null : Number(el.value);
    openPerson = p.id;
  }
  save();
  render();
});

document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details[data-person]')) {
    openPerson = e.target.open ? e.target.dataset.person : (openPerson === e.target.dataset.person ? null : openPerson);
  }
}, true);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
