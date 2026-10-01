const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pl = require('../src/pl.js');
const shopify = require('../src/shopify.js');

const TZ = 'America/New_York';

function loadFixture(name) {
  const fixturePath = path.join(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

test('API_VERSION is pinned to a single constant', () => {
  assert.equal(shopify.API_VERSION, '2026-07');
});

test('ordersQueryFilter: full sync vs incremental since a timestamp', () => {
  assert.equal(shopify.ordersQueryFilter(null), 'status:any');
  assert.equal(shopify.ordersQueryFilter("2026-06-01T00:00:00.000Z"), "status:any updated_at:>'2026-06-01T00:00:00.000Z'");
});

test('incrementalSinceIso subtracts the 10-minute overlap window', () => {
  const since = shopify.incrementalSinceIso('2026-06-01T00:10:00.000Z');
  assert.equal(since, '2026-06-01T00:00:00.000Z');
});

test('normalizeShopDomain strips protocol/path and defaults to .myshopify.com', () => {
  assert.equal(shopify.normalizeShopDomain('https://my-dev-store.myshopify.com/admin'), 'my-dev-store.myshopify.com');
  assert.equal(shopify.normalizeShopDomain('my-dev-store'), 'my-dev-store.myshopify.com');
  assert.equal(shopify.normalizeShopDomain(' my-dev-store.myshopify.com '), 'my-dev-store.myshopify.com');
});

test('hasReadAllOrdersScope checks for the read_all_orders handle', () => {
  assert.equal(shopify.hasReadAllOrdersScope([{ handle: 'read_orders' }]), false);
  assert.equal(shopify.hasReadAllOrdersScope([{ handle: 'read_orders' }, { handle: 'read_all_orders' }]), true);
  assert.equal(shopify.hasReadAllOrdersScope([]), false);
  assert.equal(shopify.hasReadAllOrdersScope(undefined), false);
});

test('computeBackoffMs waits only for the cost deficit, at the restore rate', () => {
  assert.equal(shopify.computeBackoffMs({ currentlyAvailable: 500, restoreRate: 50 }, 100), 0);
  assert.equal(shopify.computeBackoffMs({ currentlyAvailable: 100, restoreRate: 50 }, 200), 2000);
  assert.equal(shopify.computeBackoffMs(null, 200), 0);
});

test('nextPageSize scales with live cost instead of staying hardcoded to 250', () => {
  const cheap = shopify.nextPageSize(50, {
    actualQueryCost: 50,
    throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 },
  });
  assert.equal(cheap, 250, 'cheap per-order cost should ramp up to the 250 ceiling');

  const expensive = shopify.nextPageSize(50, {
    actualQueryCost: 500,
    throttleStatus: { currentlyAvailable: 100, restoreRate: 50 },
  });
  assert.equal(expensive, 10, 'expensive per-order cost with little budget should shrink the page');

  assert.equal(shopify.nextPageSize(50, null), 50, 'missing cost info keeps the previous page size');
});

test('parseOrdersResponse: a sample sync page maps to orders, pageInfo, and cost', () => {
  const fixture = loadFixture('orders-sync-page.json');
  const page = shopify.parseOrdersResponse(fixture);

  assert.equal(page.nodes.length, 2);
  assert.equal(page.hasNextPage, true);
  assert.equal(page.endCursor, 'eyJsYXN0X2lkIjo1NTUxMDExfQ==');
  assert.equal(page.cost.actualQueryCost, 38);
  assert.equal(page.cost.throttleStatus.currentlyAvailable, 962);

  const orders = page.nodes.map((node) => pl.normalizeOrder(node, TZ));
  assert.equal(orders[0].test, false);
  assert.equal(orders[0].cancelled, false);
  assert.equal(orders[0].grossCents, 3000);
  assert.equal(orders[0].refunds[0].merchandiseCents, 1500);
  assert.equal(orders[1].test, true);
  assert.equal(orders[1].cancelled, false);
});

test('parseOrdersResponse throws, and flags THROTTLED errors for backoff-and-retry', () => {
  assert.throws(() => shopify.parseOrdersResponse({ errors: [{ message: 'boom' }] }), /boom/);

  try {
    shopify.parseOrdersResponse({
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
    });
    assert.fail('expected parseOrdersResponse to throw');
  } catch (err) {
    assert.equal(err.throttled, true);
  }
});

test('isRefundListTruncated compares summed refunds against the order total', () => {
  const complete = {
    totalRefundedSet: { shopMoney: { amount: '15.00' } },
    refunds: [{ totalRefundedSet: { shopMoney: { amount: '15.00' } } }],
  };
  assert.equal(shopify.isRefundListTruncated(complete), false);

  const truncated = {
    totalRefundedSet: { shopMoney: { amount: '25.00' } },
    refunds: [{ totalRefundedSet: { shopMoney: { amount: '15.00' } } }],
  };
  assert.equal(shopify.isRefundListTruncated(truncated), true);

  assert.equal(shopify.isRefundListTruncated({ refunds: [] }), false, 'no totalRefundedSet means nothing to check');
});

test('nestedTruncationWarnings flags any connection with hasNextPage', () => {
  const clean = loadFixture('orders-sync-page.json').data.orders.nodes[0];
  assert.deepEqual(shopify.nestedTruncationWarnings(clean), []);

  const truncatedLineItems = {
    lineItems: { pageInfo: { hasNextPage: true } },
    refunds: [{ refundLineItems: { pageInfo: { hasNextPage: true } } }],
  };
  assert.deepEqual(shopify.nestedTruncationWarnings(truncatedLineItems), ['lineItems', 'refundLineItems']);
});
