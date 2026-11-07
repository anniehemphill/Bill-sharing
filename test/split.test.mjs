import assert from 'node:assert/strict';
import test from 'node:test';
import { apportion, computeSplit, parseReceipt, splitUnits, toCents } from '../split.js';

test('apportion always sums exactly', () => {
  assert.deepEqual(apportion(100, [1, 1, 1]), [34, 33, 33]);
  for (let t = 0; t < 500; t += 7) assert.equal(apportion(t, [1, 2, 3, 4]).reduce((a, b) => a + b), t);
});

test('shared items, tips, per-person override, unclaimed', () => {
  const bill = {
    tipPct: 10,
    people: [{ id: 'a', name: 'A', tipPct: null }, { id: 'b', name: 'B', tipPct: 15 }, { id: 'c', name: 'C', tipPct: null }],
    items: [
      { id: 1, name: 'Burger', price: 12000, claims: ['a'] },
      { id: 2, name: 'Nachos', price: 10000, claims: ['a', 'b', 'c'] },
      { id: 3, name: 'Steak', price: 25000, claims: ['b'] },
      { id: 4, name: 'Coffee', price: 3000, claims: [] },
    ],
  };
  const r = computeSplit(bill);
  const [a, b, c] = r.people;
  assert.equal(a.subtotal, 12000 + 3334);
  assert.equal(b.subtotal, 25000 + 3333);
  assert.equal(c.subtotal, 3333);
  assert.equal(a.tip, 1533); assert.equal(b.tip, 4250); assert.equal(c.tip, 333);
  assert.equal(r.unclaimed, 3000);
  assert.equal(r.itemsTotal, 50000);
  assert.equal(a.subtotal + b.subtotal + c.subtotal + r.unclaimed, r.itemsTotal);
});

test('parse receipt text', () => {
  const text = `THE GRILL HOUSE
Table 4   Server: Sipho
2 Castle Lite        70.00
Cheese Burger       R 129.50
Greek Salad          89,00
Coke Zero            32.00
SUBTOTAL            320.50
VAT 15%              41.80
TOTAL              R320.50
VISA               320.50`;
  const { items, detectedTotal } = parseReceipt(text);
  assert.deepEqual(items.map((i) => [i.name, i.price, i.qty]), [
    ['Castle Lite', 7000, 2], ['Cheese Burger', 12950, 1], ['Greek Salad', 8900, 1], ['Coke Zero', 3200, 1],
  ]);
  assert.equal(detectedTotal, 32050);
  assert.deepEqual(splitUnits(items[0]).map((u) => [u.name, u.price]), [['Castle Lite', 3500], ['Castle Lite', 3500]]);
});

test('toCents handles comma decimals', () => {
  assert.equal(toCents('12,50'), 1250);
  assert.equal(toCents('abc'), 0);
});

test('multi-quantity items: each person pays for the units they picked', () => {
  const people = [{ id: 'a', name: 'A', tipPct: null }, { id: 'b', name: 'B', tipPct: null }, { id: 'c', name: 'C', tipPct: null }];
  // 3 beers for R105: A had 2, B had 1
  let r = computeSplit({ tipPct: 10, people, items: [{ id: 1, name: '3× Castle Lite', price: 10500, qty: 3, units: { a: 2, b: 1 } }] });
  assert.deepEqual(r.people.map((p) => p.subtotal), [7000, 3500, 0]);
  assert.equal(r.unclaimed, 0);
  assert.equal(r.people[0].lines[0].units, 2);
  // only 1 of 3 picked -> 2 left over, outstanding
  r = computeSplit({ tipPct: 0, people, items: [{ id: 1, name: 'Beer', price: 10500, qty: 3, units: { c: 1 } }] });
  assert.equal(r.people[2].subtotal, 3500);
  assert.equal(r.unclaimed, 7000);
  assert.equal(r.unclaimedItems[0].left, 2);
  // leftover shared between everyone (_all)
  r = computeSplit({ tipPct: 0, people, items: [{ id: 1, name: 'Beer', price: 10000, qty: 4, units: { a: 1, _all: 3 } }] });
  assert.deepEqual(r.people.map((p) => p.subtotal), [2500 + 2500, 2500, 2500]);
  assert.equal(r.unclaimed, 0);
  // more picked than on the bill -> flagged, still adds up to the price
  r = computeSplit({ tipPct: 0, people, items: [{ id: 1, name: 'Beer', price: 9000, qty: 2, units: { a: 2, b: 1 } }] });
  assert.equal(r.overClaimed.length, 1);
  assert.equal(r.people[0].subtotal + r.people[1].subtotal, 9000);
});

test('per-person tip choice, ignored when service charge is on the bill', () => {
  const people = [{ id: 'a', name: 'A', tipPct: null }, { id: 'b', name: 'B', tipPct: 20 }];
  const items = [{ id: 1, name: 'X', price: 10000, claims: ['a'] }, { id: 2, name: 'Y', price: 10000, claims: ['b'] }];
  let r = computeSplit({ tipPct: 10, people, items });
  assert.deepEqual(r.people.map((p) => p.tip), [1000, 2000]);
  r = computeSplit({ tipPct: 10, serviceIncluded: true, people, items });
  assert.deepEqual(r.people.map((p) => p.tip), [0, 0]);
});
