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
    ['2× Castle Lite', 7000, 2], ['Cheese Burger', 12950, 1], ['Greek Salad', 8900, 1], ['Coke Zero', 3200, 1],
  ]);
  assert.equal(detectedTotal, 32050);
  assert.deepEqual(splitUnits(items[0]).map((u) => [u.name, u.price]), [['Castle Lite', 3500], ['Castle Lite', 3500]]);
});

test('toCents handles comma decimals', () => {
  assert.equal(toCents('12,50'), 1250);
  assert.equal(toCents('abc'), 0);
});
