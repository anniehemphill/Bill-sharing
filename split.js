// Pure bill-splitting logic. No DOM — tested in test/split.test.mjs.

export const toCents = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const fmt = (cents, cur = 'R') => {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${cur}${(Math.abs(cents) / 100).toFixed(2)}`;
};

// Split `total` cents across `weights` so the parts always add up exactly
// (largest-remainder method). Returns an array of integer cents.
export function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

// bill = { items: [{id, name, price (cents), claims: [personId]}],
//          people: [{id, name, tipPct: number|null}], tipPct }
// Returns per-person breakdown plus bill-level checks.
// Units each person picked on a multi-quantity item: {personId: n, _all: n}.
// `_all` = units split equally between everyone. Plain ticks count as 1 unit.
export function unitsOf(item) {
  if (item.units) return item.units;
  return Object.fromEntries((item.claims || []).map((id) => [id, 1]));
}

// bill = { items: [{id, name, price (cents), qty, claims: [personId], units?: {personId: n}}],
//          people: [{id, name, tipPct: number|null}], tipPct }
// qty 1 items: everyone who ticks it shares it equally.
// qty > 1 items: each person pays for the number of units they picked.
// Returns per-person breakdown plus bill-level checks.
export function computeSplit(bill) {
  const people = bill.people;
  const idx = new Map(people.map((p, i) => [p.id, i]));
  const sub = people.map(() => 0);
  const lines = people.map(() => []);
  let unclaimed = 0;
  const unclaimedItems = [];
  const overClaimed = [];

  const give = (id, share, line) => {
    const i = idx.get(id);
    sub[i] += share;
    lines[i].push({ ...line, share });
  };

  for (const item of bill.items) {
    const qty = item.qty || 1;
    if (qty > 1) {
      const u = unitsOf(item);
      const ids = Object.keys(u).filter((id) => idx.has(id) && u[id] > 0);
      const counts = ids.map((id) => u[id]);
      const all = people.length ? Math.max(0, u._all || 0) : 0;
      const taken = counts.reduce((a, b) => a + b, 0) + all;
      if (!taken) {
        unclaimed += item.price;
        unclaimedItems.push({ ...item, left: qty });
        continue;
      }
      if (taken > qty) overClaimed.push({ ...item, taken });
      const left = Math.max(0, qty - taken);
      const weights = [...counts, ...(all ? [all] : []), ...(left ? [left] : [])];
      const parts = apportion(item.price, weights);
      ids.forEach((id, k) => give(id, parts[k], { name: item.name, units: counts[k], of: qty, splitWith: 1 }));
      if (all) {
        const allPart = parts[ids.length];
        const each = apportion(allPart, people.map(() => 1));
        people.forEach((p, k) => give(p.id, each[k], { name: item.name, units: all, of: qty, splitWith: people.length }));
      }
      if (left) {
        const leftPart = parts.at(-1);
        unclaimed += leftPart;
        unclaimedItems.push({ ...item, price: leftPart, left });
      }
      continue;
    }
    const claimants = (item.claims || []).filter((id) => idx.has(id));
    if (!claimants.length) {
      unclaimed += item.price;
      unclaimedItems.push(item);
      continue;
    }
    const parts = apportion(item.price, claimants.map(() => 1));
    claimants.forEach((id, k) => give(id, parts[k], { name: item.name, splitWith: claimants.length }));
  }

  const result = people.map((p, i) => {
    // A service charge already on the bill means no tip for anyone.
    const pct = bill.serviceIncluded ? 0 : (p.tipPct ?? bill.tipPct ?? 0);
    const tip = Math.round((sub[i] * pct) / 100);
    return { id: p.id, name: p.name, subtotal: sub[i], tipPct: pct, tip, total: sub[i] + tip, lines: lines[i] };
  });

  const itemsTotal = bill.items.reduce((a, it) => a + it.price, 0);
  return {
    people: result,
    itemsTotal,
    unclaimed,
    unclaimedItems,
    overClaimed,
    tipTotal: result.reduce((a, r) => a + r.tip, 0),
    grandTotal: result.reduce((a, r) => a + r.total, 0) + unclaimed,
  };
}

// --- Receipt text parsing (OCR output → items) ---

const SKIP = /\b(sub\s*-?\s*total|total|vat|tax|tip|gratuity|service|change|cash|card|visa|master|balance|amount\s+due|tendered|rounding|discount|table|server|waiter|invoice|tel|date|time)\b/i;
const TOTAL = /\b(total|amount\s+due|balance\s+due)\b/i;
const PRICE = /(-?\d{1,6}(?:[ ,]\d{3})*[.,]\d{2})\s*[A-Z]?\s*$/;

const parseAmount = (s) => {
  // "1 234.50" / "1,234.50" / "45,00"
  let t = s.replace(/\s/g, '');
  if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  return toCents(t);
};

export function parseReceipt(text) {
  const items = [];
  let detectedTotal = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[|_~*]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const m = line.match(PRICE);
    if (!m) continue;
    const price = parseAmount(m[1]);
    let name = line.slice(0, m.index).replace(/\s*(R|ZAR|\$|€|£)\s*$/i, '').trim();
    if (TOTAL.test(name) && !/sub/i.test(name)) {
      detectedTotal = price; // keep last "total" seen
      continue;
    }
    if (SKIP.test(name) || price <= 0) continue;
    let qty = 1;
    const q = name.match(/^(\d{1,2})\s*[xX@]?\s+(.+)$/);
    if (q) { qty = parseInt(q[1], 10); name = q[2]; }
    name = name.replace(/^[^A-Za-z0-9]+/, '').trim();
    if (name.length < 2) continue;
    items.push({ name, price, qty });
  }
  return { items, detectedTotal };
}

// Split a multi-quantity item into single units so different people can claim each.
export function splitUnits(item) {
  const parts = apportion(item.price, Array(item.qty).fill(1));
  const base = item.name.replace(/^\d+×\s*/, '');
  return parts.map((price) => ({ name: base, price, qty: 1 }));
}
