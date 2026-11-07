// Tiny client for the Firebase Realtime Database REST API.
// Each shared bill lives at /bills/<cloudId>. The id is a long random string:
// anyone who has the link can read and edit that bill, and nobody can list bills.
import { DB_URL } from './config.js';

export const cloudEnabled = () => Boolean(DB_URL);

async function req(method, path, body) {
  const res = await fetch(`${DB_URL.replace(/\/$/, '')}/${path}.json`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Couldn't sync (${res.status}). Check your connection.`);
  return res.json();
}

export const cget = (path) => req('GET', path);
export const cput = (path, value) => (value === null ? req('DELETE', path) : req('PUT', path, value));
// Multi-path update: { 'a/b': 1, 'c': null } — null deletes.
export const cpatch = (path, updates) => req('PATCH', path, updates);

export function newCloudId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('');
}

// Local bill -> cloud document. Phone numbers stay on the host's phone.
export function toCloud(bill, settings) {
  const items = {};
  const claims = {};
  bill.items.forEach((it, o) => {
    items[it.id] = { name: it.name, price: it.price, qty: it.qty || 1, o };
    if ((it.qty || 1) > 1) {
      const u = Object.entries(it.units || {}).filter(([, n]) => n > 0);
      if (u.length) claims[it.id] = Object.fromEntries(u);
    } else if (it.claims.length) claims[it.id] = Object.fromEntries(it.claims.map((p) => [p, true]));
  });
  const people = {};
  bill.people.forEach((p, o) => { people[p.id] = { name: p.name, o, paid: Boolean(p.paid), paidAmt: p.paidAmt ?? null, done: false, seen: false }; });
  return {
    v: 1,
    created: bill.created,
    place: bill.place || '',
    host: settings.myName || 'Your friend',
    currency: settings.currency,
    tipPct: bill.tipPct,
    serviceIncluded: Boolean(bill.serviceIncluded),
    items,
    people,
    claims,
  };
}

// Cloud document -> bill shape that computeSplit understands.
export function fromCloud(c) {
  const byOrder = (obj) => Object.entries(obj || {}).sort((a, b) => (a[1].o ?? 0) - (b[1].o ?? 0));
  return {
    created: c.created,
    place: c.place || '',
    host: c.host,
    currency: c.currency,
    tipPct: c.tipPct ?? 0,
    serviceIncluded: Boolean(c.serviceIncluded),
    items: byOrder(c.items).map(([id, it]) => {
      const raw = (c.claims || {})[id] || {};
      // A claim is `true` (a tick) or a number of units picked.
      const units = Object.fromEntries(Object.entries(raw).map(([p, v]) => [p, v === true ? 1 : Number(v) || 0]));
      return {
        id, name: it.name, price: it.price, qty: it.qty || 1, o: it.o,
        claims: Object.keys(raw).filter((p) => p !== '_all'), units,
      };
    }),
    people: byOrder(c.people).map(([id, p]) => ({
      id, name: p.name, o: p.o, paid: Boolean(p.paid), paidAmt: p.paidAmt ?? null, done: Boolean(p.done), seen: Boolean(p.seen), tipPct: null,
    })),
  };
}
