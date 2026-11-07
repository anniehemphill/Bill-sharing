import { computeSplit, fmt, toCents, parseReceipt, unitsOf } from './split.js';
import { parseVCards } from './contacts.js';
import { cloudEnabled, cget, cput, cpatch, newCloudId, toCloud, fromCloud } from './cloud.js';

// ---------- state ----------
const KEY = 'splitit:v1';
const uid = () => Math.random().toString(36).slice(2, 10);
const ME = 'me';
const TIP = 10; // default tip %
const TIP_OPTIONS = [10, 15, 20];
const STEPS = ['items', 'people', 'claim', 'pay'];

const defaults = () => ({
  friends: [],
  settings: { myName: 'Me', myPhone: '', currency: 'R', countryCode: '27' },
  bill: null,
  history: [],
  joined: [], // bills friends invited me to: {cloudId, pid, place, host, created}
});

let state;
try { state = { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
catch { state = defaults(); }
state.settings = { ...defaults().settings, ...state.settings };
state.joined = state.joined || [];

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };

let tab = 'bill';
let claimer = ME;      // person currently picking items (host screen)
let ocr = null;        // {pct, status} while scanning
let openPerson = null; // expanded breakdown on pay screen
let gb = null;         // guest view: {id, bill} | {id, missing: true}

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const route = () => {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get('b') ? { id: h.get('b'), pid: h.get('p') } : null;
};
const currency = () => (route() && gb?.bill?.currency) || state.settings.currency;
const money = (c) => fmt(c, currency());
const cents2str = (c) => (c / 100).toFixed(2);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const appBase = () => location.origin + location.pathname;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

function intlNumber(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return state.settings.countryCode + d.slice(1);
  return d;
}

const people = () => state.bill?.people || [];

// 10% / 15% / 20% buttons for one person. Hidden when a service charge is already on the bill.
function tipChips(bill, person, act) {
  if (bill.serviceIncluded) return '<p class="muted" style="margin:6px 0 0">No tip: service charge is already on the bill.</p>';
  const cur = person.tipPct ?? bill.tipPct ?? TIP;
  return `<div class="row" style="gap:6px;margin-top:8px"><span class="muted" style="font-size:14px">Tip</span>
    ${TIP_OPTIONS.map((t) => `<button class="chip ${cur === t ? 'on' : ''}" data-act="${act}" data-id="${person.id}" data-v="${t}">${t}%</button>`).join('')}</div>`;
}

// "Castle Lite ×2", "Nachos (÷3)", "Castle Lite (leftover ÷3)"
function lineLabel(l, html = true) {
  const extra = l.units != null
    ? (l.splitWith > 1 ? ` (${l.units} left over, shared ÷${l.splitWith})` : ` ×${l.units}`)
    : (l.splitWith > 1 ? ` (shared ÷${l.splitWith})` : '');
  return html ? `${esc(l.name)}${extra ? ` <span class="muted">${esc(extra.trim())}</span>` : ''}` : `${l.name}${extra}`;
}
const unclaimedLabel = (i) => (i.left != null && (i.qty || 1) > 1 ? `${i.name} (${i.left} of ${i.qty} not picked)` : i.name);
const personName = (id, list = people()) => list.find((p) => p.id === id)?.name || '?';

// ---------- cloud sync ----------
let lastWrite = 0;
let lastSeen = '';
let polling = false;

// Write a multi-path update to the current host bill (no-op if not shared).
function sync(updates) {
  const id = state.bill?.cloudId;
  if (!id) return;
  lastWrite = Date.now();
  cpatch(`bills/${id}`, updates).catch((e) => toast(e.message)).finally(() => { lastWrite = Date.now(); });
}

function syncGuest(updates) {
  const r = route();
  lastWrite = Date.now();
  cpatch(`bills/${r.id}`, updates).catch((e) => toast(e.message)).finally(() => { lastWrite = Date.now(); });
}

async function publish() {
  const b = state.bill;
  if (b.cloudId) return true;
  const id = newCloudId();
  try {
    await cput(`bills/${id}`, toCloud(b, state.settings));
    b.cloudId = id;
    save();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

function mergeHost(c) {
  const b = state.bill;
  const cb = fromCloud(c);
  const localP = new Map(b.people.map((p) => [p.id, p]));
  b.people = cb.people.map((p) => ({ ...localP.get(p.id), ...p }));
  b.items = cb.items;
  b.place = cb.place;
  b.tipPct = cb.tipPct;
  b.serviceIncluded = cb.serviceIncluded;
}

async function poll(force = false) {
  if (!cloudEnabled() || polling) return;
  if (!force && (document.hidden || Date.now() - lastWrite < 2500)) return;
  const r = tab === 'bill' ? route() : null;
  const id = r ? r.id : (tab === 'bill' ? state.bill?.cloudId : null);
  if (!id) return;
  polling = true;
  try {
    const c = await cget(`bills/${id}`);
    if (!force && Date.now() - lastWrite < 2500) return; // a local edit happened meanwhile
    const seen = id + JSON.stringify(c);
    if (seen === lastSeen && gb?.id === id) return;
    lastSeen = seen;
    if (r) {
      gb = c ? { id, bill: fromCloud(c) } : { id, missing: true };
      guestLoaded(r);
    } else if (c && state.bill?.cloudId === id) {
      mergeHost(c);
      save();
    }
    if (!document.activeElement?.matches('#view input, #view select')) render();
  } catch (e) {
    if (r && !gb) { gb = { id, error: e.message }; render(); }
  } finally {
    polling = false;
  }
}
setInterval(poll, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });

// ---------- host bill ----------
function newBill() {
  const s = state.settings;
  state.bill = {
    id: uid(),
    cloudId: null,
    created: Date.now(),
    place: '',
    items: [],
    people: [{ id: ME, name: s.myName || 'Me', phone: s.myPhone, tipPct: null, paid: false }],
    tipPct: TIP,
    serviceIncluded: false,
    detectedTotal: null,
    step: 'items',
  };
  claimer = ME;
  save();
}

const inviteLink = (pid) => `${appBase()}#b=${state.bill.cloudId}&p=${pid}`;
const groupLink = () => `${appBase()}#b=${state.bill.cloudId}`;

function inviteText(p) {
  const b = state.bill;
  return `Hi ${p.name}! ${state.settings.myName} has split the bill${b.place ? ` at ${b.place}` : ''}. ` +
    `Tap the link and tick what you had. It'll show what to pay the waiter for your share (incl. a 10% tip, or 15% / 20% if you'd like to tip more):\n${inviteLink(p.id)}`;
}

function groupText() {
  const b = state.bill;
  return `${state.settings.myName} has split the bill${b.place ? ` at ${b.place}` : ''}. ` +
    `Tap the link, pick your name and tick what you had. It'll show what to pay the waiter for your share:\n${groupLink()}`;
}

function requestText(id) {
  const b = state.bill;
  const p = computeSplit(b).people.find((x) => x.id === id);
  const lines = p.lines.map((l) => `• ${lineLabel(l, false)}: ${money(l.share)}`).join('\n');
  const link = b.cloudId ? `\n\nOpen your share: ${inviteLink(id)}` : '';
  return `Hi ${p.name}, here's your share${b.place ? ` at ${b.place}` : ''}:\n${lines}\nFood: ${money(p.subtotal)}\nTip (${p.tipPct}%): ${money(p.tip)}\nPay the waiter: ${money(p.total)}${link}`;
}

function summaryText() {
  const b = state.bill;
  const r = computeSplit(b);
  return `${b.place || 'Bill'} — ${new Date(b.created).toLocaleDateString()}\n` +
    r.people.map((p) => `${p.name}: ${money(p.total)} (food ${money(p.subtotal)} + tip ${money(p.tip)})`).join('\n') +
    `\nTotal incl. tip: ${money(r.grandTotal)}`;
}

// What someone still has to pay. If their share grew after they paid
// (e.g. unticked items were split later), they owe the difference.
const owing = (person, total) => (person.paid ? Math.max(0, total - (person.paidAmt ?? total)) : total);

// Toggle paid. Tapping when someone owes extra records the top-up instead of un-paying.
function togglePaid(person, total) {
  if (!person.paid || owing(person, total) > 0) { person.paid = true; person.paidAmt = total; }
  else { person.paid = false; person.paidAmt = null; }
  return { paid: person.paid, paidAmt: person.paidAmt };
}

// "Is the whole bill covered?" — shown to the host and every friend.
function coverageCard(bill, res, { shareBtn = false } = {}) {
  const pOf = (id) => bill.people.find((x) => x.id === id);
  const unpaid = res.people.filter((p) => owing(pOf(p.id), p.total) > 0);
  const paid = res.people.filter((p) => pOf(p.id).paid && owing(pOf(p.id), p.total) === 0);
  const stillToPay = unpaid.reduce((a, p) => a + owing(pOf(p.id), p.total), 0) + res.unclaimed;
  const payLine = !unpaid.length && !res.unclaimed
    ? '<div class="paid">✓ Everyone has paid</div>'
    : `<div>Paid: ${paid.length} of ${bill.people.length} people · <strong>${money(stillToPay)}</strong> still to pay${unpaid.length ? ` (${esc(unpaid.map((p) => p.name).join(', '))})` : ''}</div>`;
  const over = res.overClaimed.length
    ? `<div class="banner"><strong>Too many picked:</strong> ${esc(res.overClaimed.map((i) => `${i.name}: ${i.taken} picked but only ${i.qty} on the bill`).join('; '))}. Someone needs to lower theirs.</div>`
    : '';
  if (res.unclaimed) {
    return over + `<div class="banner">
      <strong>Not covered yet: ${money(res.unclaimed)} not ticked by anyone</strong>
      <div>${esc(res.unclaimedItems.map(unclaimedLabel).join(', '))}</div>
      <div style="margin-top:6px">${payLine}</div>
      ${shareBtn ? '<button class="btn small" style="margin-top:8px" data-act="share-rest">Split unticked items equally between everyone</button>' : ''}
    </div>`;
  }
  return over + `<div class="banner ok"><strong>✓ Whole bill covered</strong> — every item is ticked by someone.<div style="margin-top:6px">${payLine}</div></div>`;
}

function statusOf(p, total) {
  const extra = owing(p, total);
  if (p.paid && extra > 0) return `<span style="color:var(--warn)">Paid ${money(p.paidAmt)} — owes ${money(extra)} more</span>`;
  if (p.paid) return '<span class="paid">✓ Paid</span>';
  if (p.id === ME) return 'Not paid yet';
  if (p.done) return 'Ready to pay';
  if (p.seen) return 'Opened the link, picking…';
  return 'Not opened yet';
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); } catch {}
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it into a chat'); }
  catch { toast("Couldn't copy"); }
}

function openWhatsApp(phone, text) {
  const n = intlNumber(phone);
  window.open(`https://wa.me/${n}?text=${encodeURIComponent(text)}`, '_blank');
}

function openSms(phone, text) {
  const n = intlNumber(phone);
  location.href = `sms:${n ? '+' + n : ''}${isIOS ? '&' : '?'}body=${encodeURIComponent(text)}`;
}

// ---------- rendering ----------
function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const back = $('#back');
  back.hidden = true;
  let html = '';
  const r = route();
  if (tab === 'friends') { $('#title').textContent = 'Friends'; html = viewFriends(); }
  else if (tab === 'settings') { $('#title').textContent = 'Settings'; html = viewSettings(); }
  else if (r) { $('#title').textContent = gb?.bill?.place || 'Your share'; html = viewGuest(r); }
  else if (!state.bill) { $('#title').textContent = 'SplitIt'; html = viewStart(); }
  else {
    $('#title').textContent = state.bill.place || 'New bill';
    back.hidden = STEPS.indexOf(state.bill.step) <= 0;
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
  const joined = state.joined.slice(0, 10).map((j) => `
    <li><div class="grow"><div class="name">${esc(j.place || 'Bill')}</div>
      <div class="muted">From ${esc(j.host || 'a friend')} · ${new Date(j.created || Date.now()).toLocaleDateString()}</div></div>
      <a class="btn small" href="#b=${esc(j.cloudId)}&p=${esc(j.pid)}">Open</a></li>`).join('');
  return `
    <div class="card">
      <h2>Split a bill</h2>
      <p class="muted">Scan the bill and add who's at the table. Everyone gets a link by WhatsApp or SMS, ticks what they had on their own phone, and sees exactly what to pay the waiter, including a ${TIP}% tip.</p>
      <button class="btn primary block" data-act="new">Start a new bill</button>
    </div>
    ${joined ? `<h3>Bills you were invited to</h3><div class="card"><ul class="list">${joined}</ul></div>` : ''}
    ${hist ? `<h3>Bills you split</h3><div class="card"><ul class="list">${hist}</ul></div>` : ''}`;
}

function viewSteps() {
  const labels = { items: '1 · Items', people: '2 · People', claim: cloudEnabled() ? '3 · Invite' : '3 · Who had what', pay: '4 · Pay' };
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
      <input style="width:52px;text-align:center" inputmode="numeric" data-edit="qty" data-id="${it.id}" value="${it.qty || 1}" aria-label="Quantity" title="Quantity">
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
      ${rows ? `<div class="row muted" style="font-size:12px;margin-top:8px"><span class="grow">Item</span><span style="width:96px">Line total</span><span style="width:52px;text-align:center">Qty</span><span style="width:44px"></span></div>
      <ul class="list">${rows}</ul>
      <p class="muted">Set Qty above 1 when a line is for several (e.g. 3 beers), so each person can pick how many they had.</p>` : '<p class="empty">No items yet. Scan the bill or add them below.</p>'}
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
    <div class="card"><strong>Add from your contacts</strong>${contactButtons('bill')}</div>
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
    <button class="btn primary block" data-act="step" data-step="claim" ${b.people.length > 1 ? '' : 'disabled'}>${cloudEnabled() ? 'Next: send everyone the bill →' : 'Next: who had what →'}</button>`;
}

function claimList(bill, pid, act) {
  return bill.items.map((it) => {
    const qty = it.qty || 1;
    if (qty > 1) {
      const u = unitsOf(it);
      const mineN = u[pid] || 0;
      const taken = Object.entries(u).reduce((a, [, n]) => a + (n > 0 ? n : 0), 0);
      const who = Object.entries(u).filter(([, n]) => n > 0)
        .map(([id, n]) => (id === '_all' ? `${n} shared by everyone` : `${personName(id, bill.people)} ×${n}`));
      const canAdd = taken < qty;
      return `<li class="item ${mineN ? 'mine' : ''}">
        <div class="grow"><div class="name">${esc(it.name)}</div>
          <div class="who">${money(Math.round(it.price / qty))} each · ${taken} of ${qty} picked${who.length ? `: ${esc(who.join(', '))}` : ''}</div></div>
        <div class="row" style="gap:6px;flex:none">
          <button class="btn small" data-act="${act}-u" data-id="${it.id}" data-d="-1" ${mineN ? '' : 'disabled'} aria-label="One less">−</button>
          <span class="amt" style="min-width:18px;text-align:center;font-weight:700">${mineN}</span>
          <button class="btn small ${canAdd ? 'primary' : ''}" data-act="${act}-u" data-id="${it.id}" data-d="1" ${canAdd ? '' : 'disabled'} aria-label="One more">+</button>
        </div></li>`;
    }
    const has = it.claims.includes(pid);
    const who = it.claims.map((id) => personName(id, bill.people));
    return `<li class="item ${has ? 'mine' : ''}" data-act="${act}" data-id="${it.id}">
      <span class="check">${has ? '✓' : ''}</span>
      <div class="grow"><div class="name">${esc(it.name)}</div>
        <div class="who">${who.length ? (who.length > 1 ? `Shared: ${esc(who.join(', '))}` : esc(who[0])) : 'Not claimed yet'}</div></div>
      <span class="amt">${money(it.price)}</span></li>`;
  }).join('');
}

// Change how many units of a multi-quantity item `pid` picked. Returns the claim update.
function stepUnits(it, pid, d) {
  const u = { ...unitsOf(it) };
  const taken = Object.values(u).reduce((a, n) => a + (n > 0 ? n : 0), 0);
  const cur = u[pid] || 0;
  const next = d > 0 ? (taken < (it.qty || 1) ? cur + 1 : cur) : Math.max(0, cur - 1);
  if (next === cur) return null;
  if (next) u[pid] = next; else delete u[pid];
  it.units = u;
  it.claims = Object.keys(u).filter((k) => k !== '_all');
  return { [`claims/${it.id}/${pid}`]: next || null };
}

function viewInvites() {
  const b = state.bill;
  const totals = new Map(computeSplit(b).people.map((x) => [x.id, x.total]));
  const rows = b.people.filter((p) => p.id !== ME).map((p) => `
    <li style="display:block">
      <div class="row between"><strong class="name">${esc(p.name)}</strong><span class="muted">${statusOf(p, totals.get(p.id))}</span></div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn small" data-act="inv-wa" data-id="${p.id}">WhatsApp</button>
        <button class="btn small" data-act="inv-sms" data-id="${p.id}" ${p.phone ? '' : 'disabled'}>SMS</button>
        <button class="btn small" data-act="inv-share" data-id="${p.id}">Other…</button>
      </div></li>`).join('');
  return `
    <div class="card">
      <strong>Send everyone their link</strong>
      <p class="muted">Each person gets their own link. They open it on their phone, tick what they had and see what to pay the waiter. This screen updates as they go.</p>
      <ul class="list">${rows}</ul>
      <button class="btn block" data-act="inv-group">Or send one link to a group chat</button>
    </div>`;
}

function viewClaim() {
  const b = state.bill;
  if (!b.people.some((p) => p.id === claimer)) claimer = ME;
  const r = computeSplit(b);
  const mine = r.people.find((p) => p.id === claimer);
  const shared = Boolean(b.cloudId);
  const chips = b.people.map((p) =>
    `<button class="chip ${p.id === claimer ? 'on' : ''}" data-act="claimer" data-id="${p.id}">${esc(p.name)}</button>`).join('');
  return `
    ${shared ? viewInvites() : (cloudEnabled() ? '' : '<div class="banner">Sharing isn\'t set up yet, so pass the phone round. (See README → “Turn on sharing”.)</div>')}
    ${shared ? `<h3>Your items</h3><p class="muted">Tick what you had. You can also tick for someone who can't open the link — tap their name first.</p>`
             : '<p class="muted">Each person taps their name, then taps everything they had. Tap one item for several people to share it equally.</p>'}
    <div class="chips">${chips}</div>
    ${b.items.length ? coverageCard(b, r, { shareBtn: true }) : ''}
    <div class="card"><ul class="list">${claimList(b, claimer, 'claim')}</ul></div>
    <div class="card row between"><span><strong>${esc(mine?.name)}</strong> so far</span><span class="amt total-big">${money(mine?.subtotal || 0)}</span></div>
    <button class="btn primary block" data-act="step" data-step="pay">Next: what everyone pays →</button>`;
}

function viewPay() {
  const b = state.bill;
  const r = computeSplit(b);
  const cards = r.people.map((p) => {
    const person = b.people.find((x) => x.id === p.id);
    const isMe = p.id === ME;
    const open = openPerson === p.id;
    return `<div class="card">
      <div class="row between">
        <div><strong>${esc(p.name)}</strong>${isMe ? ' <span class="muted">(you)</span>' : ''}<br>
          <span class="muted">Food ${money(p.subtotal)} + tip ${money(p.tip)} (${p.tipPct}%)</span>
          <br><span class="muted">${statusOf(person, p.total)}</span></div>
        <span class="amt total-big">${money(p.total)}</span>
      </div>
      ${tipChips(b, person, 'ptip')}
      <details ${open ? 'open' : ''} data-person="${p.id}"><summary>Breakdown</summary>
        <ul class="list">${p.lines.map((l) => `<li><span class="grow name">${lineLabel(l)}</span><span class="amt">${money(l.share)}</span></li>`).join('') || '<li class="muted">Nothing claimed</li>'}</ul>
      </details>
      <div class="btn-row" style="margin-top:10px">
        ${isMe ? '' : `<button class="btn small" data-act="wa" data-id="${p.id}">WhatsApp</button>
        <button class="btn small" data-act="sms" data-id="${p.id}" ${person.phone ? '' : 'disabled'}>SMS</button>`}
        ${(() => { const ex = owing(person, p.total); return person.paid && !ex
          ? `<button class="btn small" data-act="paid" data-id="${p.id}"><span class="paid">✓ Paid</span></button>`
          : `<button class="btn small primary" data-act="paid" data-id="${p.id}">${person.paid ? `Mark extra ${money(ex)} paid` : 'Mark paid'}</button>`; })()}
      </div>
    </div>`;
  }).join('');
  const pOf = (id) => b.people.find((x) => x.id === id);
  const toPay = r.people.reduce((a, p) => a + owing(pOf(p.id), p.total), 0);
  const waiter = r.people.map((p) => {
    const ex = owing(pOf(p.id), p.total);
    const tag = pOf(p.id).paid ? (ex ? ` <span class="muted">(paid ${money(pOf(p.id).paidAmt)}, ${money(ex)} more to pay)</span>` : ' <span class="paid">✓</span>') : '';
    return `<li><span class="grow name">${esc(p.name)}${tag}</span><span class="amt total-big">${money(p.total)}</span></li>`;
  }).join('');
  return `
    ${coverageCard(b, r, { shareBtn: true })}
    <div class="card">
      <strong>Show the waiter</strong>
      <p class="muted">Each person pays the restaurant this amount (includes each person's tip).</p>
      <ul class="list">${waiter}</ul>
      <div class="row between" style="border-top:1px solid var(--line);padding-top:10px"><span>Whole bill incl. tips</span><span class="amt">${money(r.grandTotal)}</span></div>
      <div class="row between"><span class="muted">Still to pay</span><span class="amt">${money(toPay + r.unclaimed)}</span></div>
    </div>
    <div class="card">
      <strong>Tip: ${b.serviceIncluded ? '0% (service charge already on the bill)' : `${TIP}% unless someone picks more`}</strong>
      <label class="row" style="color:var(--text)"><input type="checkbox" data-act="service" ${b.serviceIncluded ? 'checked' : ''} style="width:auto"> Service charge is already on the bill</label>
      <p class="muted">Each person tips on what they ordered: ${TIP}% unless they choose 15% or 20% on their phone (or you change it below). Tick the box if the restaurant already added a service charge, so nobody tips twice.</p>
    </div>
    <h3>Each person</h3>
    ${cards}
    <div class="btn-row">
      <button class="btn" data-act="copy">Copy summary</button>
      <button class="btn primary" data-act="finish">Finish &amp; save</button>
    </div>
    ${b.cloudId ? '<button class="btn small danger block" data-act="unshare">Stop sharing this bill (deletes the online copy)</button>' : ''}`;
}

// ---------- guest (friend opening a link) ----------
function guestLoaded(r) {
  if (!gb?.bill) return;
  if (!r.pid) {
    const known = state.joined.find((j) => j.cloudId === r.id);
    if (known) { history.replaceState(null, '', `#b=${r.id}&p=${known.pid}`); r = route(); }
  }
  const me = gb.bill.people.find((p) => p.id === r.pid);
  if (!me) return;
  const entry = { cloudId: r.id, pid: r.pid, place: gb.bill.place, host: gb.bill.host, created: gb.bill.created };
  state.joined = [entry, ...state.joined.filter((j) => j.cloudId !== r.id)].slice(0, 30);
  save();
  if (!me.seen) { me.seen = true; syncGuest({ [`people/${me.id}/seen`]: true }); }
}

function viewGuest(r) {
  const home = '<button class="btn small block" data-act="leave">← My bills</button>';
  if (!cloudEnabled()) return `<div class="card empty">Sharing isn't set up in this copy of the app.</div>${home}`;
  if (!gb || gb.id !== r.id) return '<p class="empty">Loading the bill…</p>';
  if (gb.error) return `<div class="card empty">${esc(gb.error)}</div>${home}`;
  if (gb.missing) return `<div class="card empty">This bill isn't shared any more.</div>${home}`;
  const bill = gb.bill;
  const me = bill.people.find((p) => p.id === r.pid);
  if (!me) {
    const names = bill.people.filter((p) => p.id !== ME).map((p) =>
      `<button class="btn block" data-act="guest-pick" data-id="${p.id}">${esc(p.name)}</button>`).join('');
    return `<div class="card"><h2>Who are you?</h2>
      <p class="muted">${esc(bill.host)} split the bill${bill.place ? ` at ${esc(bill.place)}` : ''}. Tap your name.</p>${names}</div>${home}`;
  }
  const res = computeSplit(bill);
  const mine = res.people.find((p) => p.id === me.id);
  const extra = owing(me, mine.total);
  const totals = `<div class="card">
      <div class="row between"><span>Your food</span><span class="amt">${money(mine.subtotal)}</span></div>
      <div class="row between"><span>Tip (${mine.tipPct}%)</span><span class="amt">${money(mine.tip)}</span></div>
      <div class="row between" style="margin-top:6px"><strong>Your share</strong><span class="amt total-big">${money(mine.total)}</span></div>
      ${tipChips(bill, me, 'gtip')}
    </div>`;
  if (!me.done) {
    return `
      <div class="card"><strong>Hi ${esc(me.name)} 👋</strong>
        <p class="muted">${esc(bill.host)} is splitting the bill${bill.place ? ` at ${esc(bill.place)}` : ''}. Tap everything you had. If you shared something, tap it too — it's split between everyone who taps it. For items with + and −, tap + once for each one you had.</p></div>
      ${coverageCard(bill, res)}
      <div class="card"><ul class="list">${claimList(bill, me.id, 'gclaim')}</ul></div>
      ${totals}
      <button class="btn primary block" data-act="gdone" ${mine.subtotal ? '' : 'disabled'}>Done — what do I pay?</button>
      ${home}`;
  }
  return `
    ${totals}
    ${coverageCard(bill, res)}
    <div class="card">
      <strong>Pay the restaurant</strong>
      ${extra && me.paid
        ? `<p>You paid <strong>${money(me.paidAmt)}</strong>, but your share has gone up to <strong>${money(mine.total)}</strong> (someone split an item with you). Please pay the waiter <strong>${money(extra)}</strong> more.</p>
           <button class="btn block primary" data-act="gpaid">I've paid the extra ${money(extra)}</button>`
        : `<p>Tell the waiter you're paying <strong>${money(mine.total)}</strong> for your share. If the card machine asks for a tip, put through <strong>${money(mine.subtotal)}</strong> and add <strong>${money(mine.tip)}</strong> as the tip.</p>
           <button class="btn block ${me.paid ? '' : 'primary'}" data-act="gpaid">${me.paid ? '<span class="paid">✓ You\'ve paid</span> — tap to undo' : "I've paid"}</button>`}
    </div>
    <details class="card"><summary>What you had</summary>
      <ul class="list">${mine.lines.map((l) => `<li><span class="grow name">${lineLabel(l)}</span><span class="amt">${money(l.share)}</span></li>`).join('')}</ul>
    </details>
    <button class="btn small block" data-act="gundone">Change my items</button>
    ${home}`;
}

// ---------- friends & settings ----------
const hasPicker = () => 'contacts' in navigator && 'select' in navigator.contacts;
function contactButtons(where) {
  return `${hasPicker() ? `<button class="btn block" data-act="pick-contact" data-where="${where}">📇 Choose from contacts</button>` : ''}
    <label class="btn block" style="margin-top:10px;text-align:center;color:var(--text)">📇 Import a shared contact card
      <input type="file" accept=".vcf,text/vcard,text/x-vcard" multiple hidden data-vcf="${where}"></label>
    <details style="margin-top:8px"><summary>How do I get a contact card?</summary>
      <p class="muted">In the Contacts app, open the person, tap <strong>Share Contact</strong>, then <strong>Save to Files</strong>. Come back here, tap “Import a shared contact card” and pick it. You can pick several at once.</p></details>`;
}

function addContacts(list, where) {
  let added = 0;
  for (const c of list) {
    const phone = String(c.phone || '').trim();
    const digits = phone.replace(/\D/g, '').slice(-9);
    let f = state.friends.find((x) => (digits && x.phone.replace(/\D/g, '').slice(-9) === digits) || x.name === c.name);
    if (!f) { f = { id: uid(), name: c.name, phone }; state.friends.push(f); added++; }
    if (where === 'bill' && state.bill && !state.bill.people.some((p) => p.friendId === f.id)) {
      addPerson({ id: uid(), friendId: f.id, name: f.name, phone: f.phone, tipPct: null, paid: false });
    }
  }
  save();
  render();
  toast(list.length ? `${list.length} contact${list.length > 1 ? 's' : ''} added` : 'No contacts found in that file');
  return added;
}

function viewFriends() {
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
    </div>
    <div class="card"><strong>Or add from your contacts</strong>${contactButtons('friends')}</div>
    <div class="card">${rows ? `<ul class="list">${rows}</ul>` : '<p class="empty">No friends saved yet.</p>'}</div>`;
}

function viewSettings() {
  const s = state.settings;
  return `
    <div class="card">
      <label>Your name (friends see this)</label><input data-set="myName" value="${esc(s.myName)}">
      <label>Currency symbol</label><input data-set="currency" value="${esc(s.currency)}" style="width:90px">
      <label>Country dialling code (for numbers starting with 0)</label><input data-set="countryCode" inputmode="numeric" value="${esc(s.countryCode)}" style="width:90px">
    </div>
    <p class="muted">Friends and phone numbers stay on this phone. When you send a bill, its items, first names and your name go to the online database so friends can open it. Anyone with the link can see and edit that bill.</p>
    <button class="btn danger block" data-act="wipe">Delete all data on this phone</button>`;
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

const itemDoc = (it, o) => ({ name: it.name, price: it.price, qty: it.qty || 1, o });

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
    const start = b.items.length;
    const added = items.map((it) => ({ ...it, id: uid(), claims: [], units: {} }));
    b.items.push(...added);
    if (detectedTotal != null) b.detectedTotal = detectedTotal;
    sync(Object.fromEntries(added.map((it, k) => [`items/${it.id}`, itemDoc(it, start + k)])));
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
function removePerson(id) {
  const b = state.bill;
  const up = { [`people/${id}`]: null };
  b.people = b.people.filter((p) => p.id !== id);
  b.items.forEach((it) => {
    if (it.claims.includes(id)) up[`claims/${it.id}/${id}`] = null;
    it.claims = it.claims.filter((c) => c !== id);
  });
  sync(up);
}

function addPerson(p) {
  const b = state.bill;
  b.people.push(p);
  sync({ [`people/${p.id}`]: { name: p.name, o: b.people.length - 1, paid: false, done: false, seen: false } });
}

document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); scrollTo(0, 0); poll(true); return; }
  if (e.target.closest('#back')) {
    state.bill.step = STEPS[Math.max(0, STEPS.indexOf(state.bill.step) - 1)];
    save(); render(); return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const b = state.bill;
  switch (act) {
    case 'new': newBill(); break;
    case 'step': {
      const to = el.dataset.step;
      if (STEPS.indexOf(to) >= 2 && cloudEnabled() && b.people.length > 1 && !b.cloudId) {
        el.disabled = true;
        if (!(await publish())) { el.disabled = false; return; }
      }
      b.step = to;
      scrollTo(0, 0);
      break;
    }
    case 'del-item':
      b.items = b.items.filter((i) => i.id !== id);
      sync({ [`items/${id}`]: null, [`claims/${id}`]: null });
      break;
    case 'clear-items':
      if (!confirm('Remove all items?')) return;
      b.items = []; b.detectedTotal = null;
      sync({ items: null, claims: null });
      break;
    case 'toggle-friend': {
      const f = state.friends.find((x) => x.id === id);
      const existing = b.people.find((p) => p.friendId === id);
      if (existing) removePerson(existing.id);
      else addPerson({ id: uid(), friendId: f.id, name: f.name, phone: f.phone, tipPct: null, paid: false });
      break;
    }
    case 'del-person': removePerson(id); break;
    case 'claimer': claimer = id; break;
    case 'claim': {
      const it = b.items.find((i) => i.id === id);
      const has = it.claims.includes(claimer);
      it.claims = has ? it.claims.filter((c) => c !== claimer) : [...it.claims, claimer];
      sync({ [`claims/${id}/${claimer}`]: has ? null : true });
      break;
    }
    case 'claim-u': {
      const up = stepUnits(b.items.find((i) => i.id === id), claimer, Number(el.dataset.d));
      if (!up) return;
      sync(up);
      break;
    }
    case 'share-rest': {
      const all = b.people.map((p) => p.id);
      const up = {};
      b.items.forEach((it) => {
        if ((it.qty || 1) > 1) {
          const u = { ...unitsOf(it) };
          const taken = Object.values(u).reduce((a, n) => a + (n > 0 ? n : 0), 0);
          const left = it.qty - taken;
          if (left > 0) { u._all = (u._all || 0) + left; it.units = u; up[`claims/${it.id}/_all`] = u._all; }
        } else if (!it.claims.length) {
          it.claims = [...all];
          up[`claims/${it.id}`] = Object.fromEntries(all.map((p) => [p, true]));
        }
      });
      sync(up);
      break;
    }
    case 'service':
      b.serviceIncluded = el.checked;
      b.tipPct = TIP;
      sync({ tipPct: b.tipPct, serviceIncluded: b.serviceIncluded });
      break;
    case 'ptip': {
      const p = b.people.find((x) => x.id === id);
      p.tipPct = Number(el.dataset.v);
      sync({ [`people/${id}/tipPct`]: p.tipPct });
      break;
    }
    case 'paid': {
      const p = b.people.find((x) => x.id === id);
      const v = togglePaid(p, computeSplit(b).people.find((x) => x.id === id).total);
      sync({ [`people/${id}/paid`]: v.paid, [`people/${id}/paidAmt`]: v.paidAmt });
      break;
    }
    case 'inv-wa': { const p = b.people.find((x) => x.id === id); openWhatsApp(p.phone, inviteText(p)); return; }
    case 'inv-sms': { const p = b.people.find((x) => x.id === id); openSms(p.phone, inviteText(p)); return; }
    case 'inv-share': { const p = b.people.find((x) => x.id === id); shareText(inviteText(p)); return; }
    case 'inv-group': shareText(groupText()); return;
    case 'wa': { const p = b.people.find((x) => x.id === id); openWhatsApp(p.phone, requestText(id)); return; }
    case 'sms': { const p = b.people.find((x) => x.id === id); openSms(p.phone, requestText(id)); return; }
    case 'copy':
      try { await navigator.clipboard.writeText(summaryText()); toast('Summary copied'); }
      catch { toast("Couldn't copy"); }
      return;
    case 'unshare':
      if (!confirm('Delete the online copy? Friends\' links will stop working.')) return;
      try { await cput(`bills/${b.cloudId}`, null); b.cloudId = null; toast('Online copy deleted'); }
      catch (err) { toast(err.message); return; }
      break;
    case 'finish':
      state.history = [b, ...state.history.filter((h) => h.id !== b.id)].slice(0, 30);
      state.bill = null;
      toast('Bill saved');
      break;
    case 'reopen': {
      const h = state.history.find((x) => x.id === id);
      state.bill = h; h.step = 'pay';
      poll(true);
      break;
    }
    case 'del-friend': state.friends = state.friends.filter((f) => f.id !== id); break;
    case 'pick-contact': {
      try {
        const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
        addContacts(picked.map((c) => ({ name: c.name?.[0] || 'Friend', phone: c.tel?.[0] || '' })), el.dataset.where);
      } catch {}
      return;
    }
    case 'wipe':
      if (!confirm('Delete all friends, bills and settings from this phone?')) return;
      state = defaults();
      break;

    // --- guest actions ---
    case 'leave': history.pushState(null, '', location.pathname); gb = null; break;
    case 'guest-pick': {
      const r = route();
      history.replaceState(null, '', `#b=${r.id}&p=${id}`);
      guestLoaded(route());
      break;
    }
    case 'gtip': {
      const r = route();
      const me = gb.bill.people.find((p) => p.id === r.pid);
      me.tipPct = Number(el.dataset.v);
      syncGuest({ [`people/${r.pid}/tipPct`]: me.tipPct });
      break;
    }
    case 'gclaim-u': {
      const up = stepUnits(gb.bill.items.find((i) => i.id === id), route().pid, Number(el.dataset.d));
      if (!up) return;
      syncGuest(up);
      break;
    }
    case 'gclaim': {
      const r = route();
      const it = gb.bill.items.find((i) => i.id === id);
      const has = it.claims.includes(r.pid);
      it.claims = has ? it.claims.filter((c) => c !== r.pid) : [...it.claims, r.pid];
      syncGuest({ [`claims/${id}/${r.pid}`]: has ? null : true });
      break;
    }
    case 'gdone': case 'gundone': {
      const r = route();
      const me = gb.bill.people.find((p) => p.id === r.pid);
      me.done = act === 'gdone';
      syncGuest({ [`people/${r.pid}/done`]: me.done });
      scrollTo(0, 0);
      break;
    }
    case 'gpaid': {
      const r = route();
      const me = gb.bill.people.find((p) => p.id === r.pid);
      const v = togglePaid(me, computeSplit(gb.bill).people.find((x) => x.id === me.id).total);
      syncGuest({ [`people/${r.pid}/paid`]: v.paid, [`people/${r.pid}/paidAmt`]: v.paidAmt });
      break;
    }
    default: return;
  }
  save();
  render();
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const data = Object.fromEntries(new FormData(f));
  const name = String(data.name || '').trim();
  if (f.id === 'add-item') {
    const price = toCents(data.price);
    if (!name || !price) return toast('Enter a name and price');
    const it = { id: uid(), name, price, qty: 1, claims: [], units: {} };
    state.bill.items.push(it);
    sync({ [`items/${it.id}`]: itemDoc(it, state.bill.items.length - 1) });
  } else if (f.id === 'add-guest') {
    if (!name) return;
    const phone = String(data.phone || '').trim();
    let friendId;
    if (data.keep) { friendId = uid(); state.friends.push({ id: friendId, name, phone }); }
    addPerson({ id: uid(), friendId, name, phone, tipPct: null, paid: false });
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
  if (el.dataset.vcf && el.files?.length) {
    const where = el.dataset.vcf;
    Promise.all([...el.files].map((f) => f.text()))
      .then((texts) => addContacts(texts.flatMap(parseVCards), where))
      .catch(() => toast("Couldn't read that file"));
    el.value = '';
    return;
  }
  const b = state.bill;
  if (el.dataset.set) {
    const k = el.dataset.set;
    state.settings[k] = el.value.trim();
    if (k === 'myName' && b) {
      b.people.find((p) => p.id === ME).name = state.settings.myName || 'Me';
      sync({ host: state.settings.myName, [`people/${ME}/name`]: state.settings.myName || 'Me' });
    }
    save();
    return;
  }
  const kind = el.dataset.edit;
  if (!kind) return;
  if (kind === 'place') {
    b.place = el.value.trim();
    sync({ place: b.place });
    save();
    $('#title').textContent = b.place || 'New bill';
    return;
  }
  if (kind === 'name' || kind === 'price') {
    const it = b.items.find((i) => i.id === el.dataset.id);
    if (kind === 'name') it.name = el.value.trim() || it.name;
    else it.price = toCents(el.value);
    sync({ [`items/${it.id}/${kind}`]: it[kind] });
  }
  if (kind === 'qty') {
    const it = b.items.find((i) => i.id === el.dataset.id);
    const q = Math.min(99, Math.max(1, parseInt(el.value, 10) || 1));
    if (q !== (it.qty || 1)) {
      // Changing quantity resets who picked it, since the old picks may no longer fit.
      it.qty = q; it.claims = []; it.units = {};
      sync({ [`items/${it.id}/qty`]: q, [`claims/${it.id}`]: null });
    }
  }
  save();
  render();
});

document.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details[data-person]')) {
    openPerson = e.target.open ? e.target.dataset.person : (openPerson === e.target.dataset.person ? null : openPerson);
  }
}, true);

window.addEventListener('hashchange', () => { gb = null; tab = 'bill'; render(); poll(true); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
poll(true);
