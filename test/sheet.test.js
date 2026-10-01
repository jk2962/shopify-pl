const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDemoOrders, dollarsToCents, centsToDollars, mergeOrdersById } = require('../src/sheet.js');

test('dollarsToCents / centsToDollars round-trip', () => {
  assert.equal(dollarsToCents('2.50'), 250);
  assert.equal(dollarsToCents(''), 0);
  assert.equal(centsToDollars(250), 2.5);
});

test('buildDemoOrders produces ~120 realistic orders', () => {
  const orders = buildDemoOrders();
  assert.equal(orders.length, 120);

  const testOrders = orders.filter((o) => o.test);
  const cancelledOrders = orders.filter((o) => o.cancelled);
  assert.equal(testOrders.length, 1);
  assert.equal(cancelledOrders.length, 1);

  const skus = new Set();
  let refundCount = 0;
  let discountCount = 0;
  for (const order of orders) {
    assert.ok(order.grossCents > 0);
    assert.ok(order.units > 0);
    assert.match(order.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const li of order.lineItems) skus.add(li.sku);
    if (order.discountCents > 0) discountCount += 1;
    if (order.refunds.length > 0) {
      refundCount += 1;
      for (const refund of order.refunds) {
        assert.match(refund.date, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(refund.merchandiseCents > 0);
      }
    }
  }
  assert.ok(skus.size >= 3, 'expected several distinct SKUs');
  assert.ok(refundCount >= 1, 'expected at least one partial refund');
  assert.ok(discountCount >= 1, 'expected at least one discounted order');
});

test('mergeOrdersById upserts by id: updates existing orders, appends new ones', () => {
  const existing = [
    { id: 'gid://shopify/Order/1', name: '#1000', grossCents: 1000 },
    { id: 'gid://shopify/Order/2', name: '#1001', grossCents: 2000 },
  ];
  const incoming = [
    { id: 'gid://shopify/Order/2', name: '#1001', grossCents: 2500 },
    { id: 'gid://shopify/Order/3', name: '#1002', grossCents: 3000 },
  ];

  const merged = mergeOrdersById(existing, incoming);

  assert.equal(merged.length, 3);
  const byId = new Map(merged.map((o) => [o.id, o]));
  assert.equal(byId.get('gid://shopify/Order/1').grossCents, 1000, 'untouched order is kept as-is');
  assert.equal(byId.get('gid://shopify/Order/2').grossCents, 2500, 'matching id is overwritten, not duplicated');
  assert.equal(byId.get('gid://shopify/Order/3').grossCents, 3000, 'new id is appended');
});
