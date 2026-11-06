import { computeSplit, fmt, toCents, parseReceipt, splitUnits } from './split.js';
import { cloudEnabled, cget, cput, cpatch, newCloudId, toCloud, fromCloud } from './cloud.js';

// ---------- state ----------
const KEY = 'splitit:v1';
const uid = () => Math.random().toString(36).slice(2, 10);
const ME = 'me';
const TIP = 10; // fixed tip %
const STEPS = ['items', 'people', 'claim', 'pay'];

const defaults = () => ({
  friends: [],
  settings: { myName: 'Me', myPhone: '', currency: 'R', countryCode: '27', payDetails: '' },
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
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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
  const qty = new Map(b.items.map((i) => [i.id, i.qty]));
  b.items = cb.items.map((i) => ({ ...i, qty: qty.get(i.id) || 1 }));
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
    people: [{ id: ME, name: s.myName || 'Me', phone: s.myPhone, tipPct: null, paid: true }],
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
    `Tap the link, tick what you had and you'll see what you owe (incl. ${b.tipPct}% tip):\n${inviteLink(p.id)}`;
}

function groupText() {
  const b = state.bill;
  return `${state.settings.myName} has split the bill${b.place ? ` at ${b.place}` : ''}. ` +
    `Tap the link, pick your name, tick what you had and you'll see what you owe:\n${groupLink()}`;
}

function requestText(id) {
  const b = state.bill;
  const p = computeSplit(b).people.find((x) => x.id === id);
  const lines = p.lines.map((l) => `• ${l.name}${l.splitWith > 1 ? ` (shared ÷${l.splitWith})` : ''}: ${money(l.share)}`).join('\n');
  const pay = state.settings.payDetails ? `\n\nPay to: ${state.settings.payDetails}` : '';
  const link = b.cloudId ? `\n\nSee it / mark as paid: ${inviteLink(id)}` : '';
  return `Hi ${p.name}, here's your share${b.place ? ` from ${b.place}` : ''}:\n${lines}\nFood: ${money(p.subtotal)}\nTip (${p.tipPct}%): ${money(p.tip)}\nTotal: ${money(p.total)}${pay}${link}\n\nThanks! — ${state.settings.myName}`;
}

function summaryText() {
  const b = state.bill;
  const r = computeSplit(b);
  return `${b.place || 'Bill'} — ${new Date(b.created).toLocaleDateString()}\n` +
    r.people.map((p) => `${p.name}: ${money(p.total)} (food ${money(p.subtotal)} + tip ${money(p.tip)})`).join('\n') +
    `\nTotal incl. tip: ${money(r.grandTotal)}`;
}

function statusOf(p) {
  if (p.id === ME) return '';
  if (p.payDirect) return p.paid ? '<span class="paid">✓ Paid the restaurant</span>' : 'Paying the restaurant directly';
  if (p.paid) return '<span class="paid">✓ Paid you</span>';
  if (p.done) return 'Done picking — not paid yet';
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
      <p class="muted">Scan the bill and add who's at the table. Everyone gets a link by WhatsApp or SMS, ticks what they had on their own phone, and sees what they owe including a ${TIP}% tip.</p>
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
    <button class="btn primary block" data-act="step" data-step="claim" ${b.people.length > 1 ? '' : 'disabled'}>${cloudEnabled() ? 'Next: send everyone the bill →' : 'Next: who had what →'}</button>`;
}

function claimList(bill, pid, act) {
  return bill.items.map((it) => {
    const has = it.claims.includes(pid);
    const who = it.claims.map((id) => personName(id, bill.people));
    return `<li class="item ${has ? 'mine' : ''}" data-act="${act}" data-id="${it.id}">
      <span class="check">${has ? '✓' : ''}</span>
      <div class="grow"><div class="name">${esc(it.name)}</div>
        <div class="who">${who.length ? (who.length > 1 ? `Shared: ${esc(who.join(', '))}` : esc(who[0])) : 'Not claimed yet'}</div></div>
      <span class="amt">${money(it.price)}</span></li>`;
  }).join('');
}

function viewInvites() {
  const b = state.bill;
  const rows = b.people.filter((p) => p.id !== ME).map((p) => `
    <li style="display:block">
      <div class="row between"><strong class="name">${esc(p.name)}</strong><span class="muted">${statusOf(p)}</span></div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn small" data-act="inv-wa" data-id="${p.id}">WhatsApp</button>
        <button class="btn small" data-act="inv-sms" data-id="${p.id}" ${p.phone ? '' : 'disabled'}>SMS</button>
        <button class="btn small" data-act="inv-share" data-id="${p.id}">Other…</button>
      </div></li>`).join('');
  return `
    <div class="card">
      <strong>Send everyone their link</strong>
      <p class="muted">Each person gets their own link. They open it on their phone, tick what they had and see what they owe. This screen updates as they go.</p>
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
    ${r.unclaimed ? `<div class="banner">${r.unclaimedItems.length} item(s) not claimed yet (${money(r.unclaimed)}).
      <button class="btn small" style="margin-top:6px" data-act="share-rest">Split unclaimed equally between everyone</button></div>` : ''}
    <div class="card"><ul class="list">${claimList(b, claimer, 'claim')}</ul></div>
    <div class="card row between"><span><strong>${esc(mine?.name)}</strong> so far</span><span class="amt total-big">${money(mine?.subtotal || 0)}</span></div>
    <button class="btn primary block" data-act="step" data-step="pay">Next: who owes what →</button>`;
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
          ${b.cloudId && !isMe ? `<br><span class="muted">${statusOf(person)}</span>` : ''}</div>
        <span class="amt total-big">${money(p.total)}</span>
      </div>
      <details ${open ? 'open' : ''} data-person="${p.id}"><summary>Breakdown</summary>
        <ul class="list">${p.lines.map((l) => `<li><span class="grow name">${esc(l.name)}${l.splitWith > 1 ? ` <span class="muted">(÷${l.splitWith})</span>` : ''}</span><span class="amt">${money(l.share)}</span></li>`).join('') || '<li class="muted">Nothing claimed</li>'}</ul>
      </details>
      ${isMe ? '' : `<div class="btn-row" style="margin-top:10px">
        <button class="btn small" data-act="wa" data-id="${p.id}">${b.cloudId ? 'Remind' : 'WhatsApp'}</button>
        <button class="btn small" data-act="sms" data-id="${p.id}" ${person.phone ? '' : 'disabled'}>SMS</button>
        <button class="btn small ${person.paid ? '' : 'primary'}" data-act="paid" data-id="${p.id}">${person.paid ? '<span class="paid">✓ Paid</span>' : 'Mark paid'}</button>
      </div>
      <label class="row" style="color:var(--text)"><input type="checkbox" data-act="direct" data-id="${p.id}" ${person.payDirect ? 'checked' : ''} style="width:auto"> Pays the restaurant directly</label>`}
    </div>`;
  }).join('');
  const pOf = (id) => b.people.find((x) => x.id === id);
  const owed = r.people.filter((p) => p.id !== ME && !pOf(p.id).paid && !pOf(p.id).payDirect).reduce((a, p) => a + p.total, 0);
  const direct = r.people.filter((p) => p.id !== ME && pOf(p.id).payDirect).reduce((a, p) => a + p.total, 0);
  return `
    ${r.unclaimed ? `<div class="banner">${money(r.unclaimed)} of items isn't claimed by anyone, so it's not in anyone's total.</div>` : ''}
    <div class="card">
      <strong>Tip: ${b.serviceIncluded ? '0% (service charge already on the bill)' : `${TIP}%`}</strong>
      <label class="row" style="color:var(--text)"><input type="checkbox" data-act="service" ${b.serviceIncluded ? 'checked' : ''} style="width:auto"> Service charge is already on the bill</label>
      <p class="muted">Each person tips ${TIP}% on what they ordered. Tick the box if the restaurant already added a service charge, so nobody tips twice.</p>
    </div>
    ${cards}
    <div class="card">
      <div class="row between"><span>Items</span><span class="amt">${money(r.itemsTotal)}</span></div>
      <div class="row between"><span>Tips</span><span class="amt">${money(r.tipTotal)}</span></div>
      ${direct ? `<div class="row between"><span>Whole bill incl. tip</span><span class="amt">${money(r.grandTotal)}</span></div>
      <div class="row between"><span>Friends paying the restaurant directly</span><span class="amt">−${money(direct)}</span></div>` : ''}
      <div class="row between" style="margin-top:6px"><strong>You pay the restaurant (incl. tip)</strong><span class="amt total-big">${money(r.grandTotal - direct)}</span></div>
      <div class="row between"><span class="muted">Still owed to you</span><span class="amt">${money(owed)}</span></div>
    </div>
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
  const hostPays = esc(bill.host);
  const totals = `<div class="card">
      <div class="row between"><span>Your food</span><span class="amt">${money(mine.subtotal)}</span></div>
      <div class="row between"><span>Tip (${mine.tipPct}%)</span><span class="amt">${money(mine.tip)}</span></div>
      <div class="row between" style="margin-top:6px"><strong>${me.payDirect ? "Your total" : `You owe ${hostPays}`}</strong><span class="amt total-big">${money(mine.total)}</span></div>
    </div>`;
  if (!me.done) {
    return `
      <div class="card"><strong>Hi ${esc(me.name)} 👋</strong>
        <p class="muted">${hostPays} paid the bill${bill.place ? ` at ${esc(bill.place)}` : ''}. Tap everything you had. If you shared something, tap it too — it's split between everyone who taps it.</p></div>
      ${res.unclaimed ? `<div class="banner">${res.unclaimedItems.length} item(s) nobody has ticked yet.</div>` : ''}
      <div class="card"><ul class="list">${claimList(bill, me.id, 'gclaim')}</ul></div>
      ${totals}
      <button class="btn primary block" data-act="gdone" ${mine.subtotal ? '' : 'disabled'}>Done — how do I pay?</button>
      ${home}`;
  }
  const choice = `<div class="card">
      <strong>How are you paying?</strong>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn ${me.payDirect ? '' : 'primary'}" data-act="gdirect" data-v="0">Pay ${hostPays}</button>
        <button class="btn ${me.payDirect ? 'primary' : ''}" data-act="gdirect" data-v="1">Pay the restaurant myself</button>
      </div></div>`;
  if (me.payDirect) {
    return `
    ${totals}
    ${choice}
    <div class="card">
      <strong>Pay the restaurant</strong>
      <p>Tell the waiter you're paying <strong>${money(mine.total)}</strong> separately. If the card machine asks for a tip, pay <strong>${money(mine.subtotal)}</strong> and add <strong>${money(mine.tip)}</strong> as the tip.</p>
      <button class="btn block ${me.paid ? '' : 'primary'}" data-act="gpaid">${me.paid ? '<span class="paid">✓ You\'ve paid the restaurant</span> — tap to undo' : "I've paid the restaurant"}</button>
    </div>
    <details class="card"><summary>What you had</summary>
      <ul class="list">${mine.lines.map((l) => `<li><span class="grow name">${esc(l.name)}${l.splitWith > 1 ? ` <span class="muted">(÷${l.splitWith})</span>` : ''}</span><span class="amt">${money(l.share)}</span></li>`).join('')}</ul>
    </details>
    <button class="btn small block" data-act="gundone">Change my items</button>
    ${home}`;
  }
  return `
    ${totals}
    ${choice}
    <div class="card">
      <strong>Pay ${hostPays}</strong>
      ${bill.payDetails ? `<p class="name">${linkify(bill.payDetails)}</p>` : `<p class="muted">${hostPays} hasn't added payment details — ask them how they'd like to be paid.</p>`}
      <div class="btn-row">
        <button class="btn" data-act="gcopy" data-amt="${cents2str(mine.total)}">Copy amount</button>
        ${bill.payDetails ? '<button class="btn" data-act="gcopy-details">Copy details</button>' : ''}
      </div>
      <button class="btn block ${me.paid ? '' : 'primary'}" data-act="gpaid">${me.paid ? '<span class="paid">✓ You said you\'ve paid</span> — tap to undo' : "I've paid"}</button>
    </div>
    <details class="card"><summary>What you had</summary>
      <ul class="list">${mine.lines.map((l) => `<li><span class="grow name">${esc(l.name)}${l.splitWith > 1 ? ` <span class="muted">(÷${l.splitWith})</span>` : ''}</span><span class="amt">${money(l.share)}</span></li>`).join('')}</ul>
    </details>
    <button class="btn small block" data-act="gundone">Change my items</button>
    ${home}`;
}

// ---------- friends & settings ----------
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
      <label>Your name (friends see this)</label><input data-set="myName" value="${esc(s.myName)}">
      <label>How friends should pay you</label>
      <input data-set="payDetails" placeholder="e.g. FNB 62xxxxxxx, ref: your name — or a payment link" value="${esc(s.payDetails)}">
      <label>Currency symbol</label><input data-set="currency" value="${esc(s.currency)}" style="width:90px">
      <label>Country dialling code (for numbers starting with 0)</label><input data-set="countryCode" inputmode="numeric" value="${esc(s.countryCode)}" style="width:90px">
    </div>
    <p class="muted">Friends and phone numbers stay on this phone. When you send a bill, its items, first names, your name and payment details go to the online database so friends can open it. Anyone with the link can see and edit that bill.</p>
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

const itemDoc = (it, o) => ({ name: it.name, price: it.price, o });

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
    const added = items.map((it) => ({ ...it, id: uid(), claims: [] }));
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
    case 'units': {
      const at = b.items.findIndex((i) => i.id === id);
      const units = splitUnits(b.items[at]).map((u) => ({ ...u, id: uid(), claims: [] }));
      b.items.splice(at, 1, ...units);
      const up = { [`items/${id}`]: null, [`claims/${id}`]: null };
      b.items.forEach((it, o) => { up[`items/${it.id}`] = itemDoc(it, o); });
      sync(up);
      break;
    }
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
    case 'share-rest': {
      const all = b.people.map((p) => p.id);
      const up = {};
      b.items.forEach((it) => {
        if (!it.claims.length) { it.claims = [...all]; up[`claims/${it.id}`] = Object.fromEntries(all.map((p) => [p, true])); }
      });
      sync(up);
      break;
    }
    case 'service':
      b.serviceIncluded = el.checked;
      b.tipPct = b.serviceIncluded ? 0 : TIP;
      b.people.forEach((p) => { p.tipPct = null; });
      sync({ tipPct: b.tipPct, serviceIncluded: b.serviceIncluded });
      break;
    case 'direct': {
      const p = b.people.find((x) => x.id === id);
      p.payDirect = el.checked;
      sync({ [`people/${id}/payDirect`]: p.payDirect });
      break;
    }
    case 'paid': {
      const p = b.people.find((x) => x.id === id);
      p.paid = !p.paid;
      sync({ [`people/${id}/paid`]: p.paid });
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
        picked.forEach((c) => state.friends.push({ id: uid(), name: c.name?.[0] || 'Friend', phone: c.tel?.[0] || '' }));
      } catch { return; }
      break;
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
    case 'gdirect': {
      const r = route();
      const me = gb.bill.people.find((p) => p.id === r.pid);
      const v = el.dataset.v === '1';
      if (me.payDirect === v) return;
      me.payDirect = v; me.paid = false;
      syncGuest({ [`people/${r.pid}/payDirect`]: v, [`people/${r.pid}/paid`]: false });
      break;
    }
    case 'gpaid': {
      const r = route();
      const me = gb.bill.people.find((p) => p.id === r.pid);
      me.paid = !me.paid;
      syncGuest({ [`people/${r.pid}/paid`]: me.paid });
      break;
    }
    case 'gcopy': case 'gcopy-details':
      try {
        await navigator.clipboard.writeText(act === 'gcopy' ? el.dataset.amt : gb.bill.payDetails);
        toast('Copied');
      } catch { toast("Couldn't copy"); }
      return;
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
    const it = { id: uid(), name, price, qty: 1, claims: [] };
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
  const b = state.bill;
  if (el.dataset.set) {
    const k = el.dataset.set;
    state.settings[k] = el.value.trim();
    if (k === 'myName' && b) {
      b.people.find((p) => p.id === ME).name = state.settings.myName || 'Me';
      sync({ host: state.settings.myName, [`people/${ME}/name`]: state.settings.myName || 'Me' });
    }
    if (k === 'payDetails') sync({ payDetails: state.settings.payDetails });
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
