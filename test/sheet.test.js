const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDemoOrders,
  dollarsToCents,
  centsToDollars,
  mergeOrdersById,
  isDemoOrderId,
  dropDemoOrders,
  effectiveOrderTimeZone,
  last30DaysRange,
  plBannerText,
} = require('../src/sheet.js');

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

test('effectiveOrderTimeZone prefers the persisted shop timezone over the sheet display timezone', () => {
  assert.equal(effectiveOrderTimeZone('America/New_York', 'America/Los_Angeles'), 'America/New_York');
  assert.equal(effectiveOrderTimeZone(null, 'America/Los_Angeles'), 'America/Los_Angeles', 'falls back pre-first-sync');
  assert.equal(effectiveOrderTimeZone('', 'America/Los_Angeles'), 'America/Los_Angeles');
});

test('last30DaysRange is a 30-day inclusive window ending on today local date', () => {
  // Built from local date parts, not UTC: a UTC-midnight Date handed to
  // Range.setValue() is converted using the script timezone and lands on the
  // previous calendar day anywhere west of UTC, clipping today's orders off
  // the Daily range.
  const { start, end } = last30DaysRange(new Date(2026, 5, 30, 12, 0, 0));
  assert.equal(end, '2026-06-30');
  assert.equal(start, '2026-06-01');
});

test('last30DaysRange takes "today" from the shop timezone, not the script timezone', () => {
  // 23:30 UTC on 2026-06-29 = 19:30 in New York (script timezone), but already
  // 00:30 on 2026-06-30 in London: a London shop's Daily range must include the 30th.
  const now = new Date('2026-06-29T23:30:00Z');
  assert.deepEqual(last30DaysRange(now, 'America/New_York'), { start: '2026-05-31', end: '2026-06-29' });
  assert.deepEqual(last30DaysRange(now, 'Europe/London'), { start: '2026-06-01', end: '2026-06-30' });
});

test('plBannerText shows the 60-day and tax-inclusive caveats, together or not at all', () => {
  assert.equal(plBannerText(true, false), '');
  assert.match(plBannerText(false, false), /last 60 days/);
  assert.match(plBannerText(true, true), /tax-inclusive/);

  const both = plBannerText(false, true);
  assert.match(both, /last 60 days/);
  assert.match(both, /tax-inclusive/);
});

test('isDemoOrderId recognizes demo-* ids only', () => {
  assert.equal(isDemoOrderId('demo-1'), true);
  assert.equal(isDemoOrderId('demo-120'), true);
  assert.equal(isDemoOrderId('gid://shopify/Order/5551009'), false);
  assert.equal(isDemoOrderId(undefined), false);
});

test('dropDemoOrders strips every demo row and keeps real ones', () => {
  const orders = [
    { id: 'demo-1', name: '#1000' },
    { id: 'gid://shopify/Order/1', name: '#2000' },
    { id: 'demo-2', name: '#1001' },
  ];
  const kept = dropDemoOrders(orders);
  assert.deepEqual(kept.map((o) => o.id), ['gid://shopify/Order/1']);
});

test('a real sync (upsertOrders semantics) must remove demo rows, not merge them', () => {
  const existingSheetRows = [...buildDemoOrders(), { id: 'gid://shopify/Order/999', name: '#9000' }];
  const incomingRealOrders = [{ id: 'gid://shopify/Order/999', name: '#9000', grossCents: 5000 }];

  const merged = mergeOrdersById(dropDemoOrders(existingSheetRows), incomingRealOrders);

  assert.equal(merged.some((o) => isDemoOrderId(o.id)), false, 'no demo-* id should survive a real sync');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].grossCents, 5000);
});
