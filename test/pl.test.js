const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pl = require('../src/pl.js');

const TZ = 'America/New_York';

function baseOrder(overrides = {}) {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1000',
    test: false,
    cancelledAt: null,
    processedAt: '2026-06-15T14:00:00Z',
    updatedAt: '2026-06-15T14:00:00Z',
    taxesIncluded: false,
    currencyCode: 'USD',
    lineItems: { nodes: [] },
    shippingLines: { nodes: [] },
    refunds: [],
    ...overrides,
  };
}

function lineItem({ sku, quantity, unitPrice, discounts = [] }) {
  return {
    sku,
    quantity,
    originalUnitPriceSet: { shopMoney: { amount: unitPrice } },
    discountAllocations: discounts.map((amount) => ({ allocatedAmountSet: { shopMoney: { amount } } })),
  };
}

function shippingLine(discountedPrice) {
  return { discountedPriceSet: { shopMoney: { amount: discountedPrice } } };
}

function refund({ processedAt, lineItems = [], shippingAmounts = [], adjustments = [] }) {
  return {
    processedAt,
    updatedAt: processedAt,
    refundLineItems: {
      nodes: lineItems.map(({ sku, quantity, subtotal }) => ({
        quantity,
        subtotalSet: { shopMoney: { amount: subtotal } },
        lineItem: { sku },
      })),
    },
    refundShippingLines: {
      nodes: shippingAmounts.map((amount) => ({ subtotalAmountSet: { shopMoney: { amount } } })),
    },
    orderAdjustments: {
      nodes: adjustments.map((amount) => ({ amountSet: { shopMoney: { amount } } })),
    },
  };
}

function baseOptions(overrides = {}) {
  return {
    timeframe: 'monthly',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    defaultCostCents: 100,
    costBySku: {},
    shippingMode: 'per_order',
    shippingRateCents: 500,
    feePct: 0.029,
    feeFixedCents: 30,
    ...overrides,
  };
}

function normalizeAll(nodes) {
  return nodes.map((n) => pl.normalizeOrder(n, TZ));
}

test('single order: gross, net, units, orders', () => {
  const node = baseOrder({
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 2, unitPrice: '15.00' })] },
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.orders, 1);
  assert.equal(row.units, 2);
  assert.equal(row.grossSalesCents, 3000);
  assert.equal(row.discountsCents, 0);
  assert.equal(row.returnsCents, 0);
  assert.equal(row.netSalesCents, 3000);
});

test('discount reduces net sales via discountAllocations', () => {
  const node = baseOrder({
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '15.00', discounts: ['3.00'] })] },
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.grossSalesCents, 1500);
  assert.equal(row.discountsCents, 300);
  assert.equal(row.netSalesCents, 1200);
});

test('partial refund is attributed to the refund month, not the order month', () => {
  const node = baseOrder({
    processedAt: '2026-06-15T14:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 2, unitPrice: '15.00' })] },
    refunds: [
      refund({
        processedAt: '2026-07-10T14:00:00Z',
        lineItems: [{ sku: 'MUG-01', quantity: 1, subtotal: '15.00' }],
      }),
    ],
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const june = rows.find((r) => r.period === '2026-06');
  const july = rows.find((r) => r.period === '2026-07');
  assert.equal(june.grossSalesCents, 3000);
  assert.equal(june.returnsCents, 0);
  assert.equal(july.grossSalesCents, 0);
  assert.equal(july.returnsCents, 1500);
});

test('cancelled and test orders are excluded entirely', () => {
  const cancelled = baseOrder({
    id: 'o1',
    cancelledAt: '2026-06-01T00:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 5, unitPrice: '15.00' })] },
  });
  const testOrder = baseOrder({
    id: 'o2',
    test: true,
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 5, unitPrice: '15.00' })] },
  });
  const { rows } = pl.computeRows(normalizeAll([cancelled, testOrder]), baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.orders, 0);
  assert.equal(row.units, 0);
  assert.equal(row.grossSalesCents, 0);
});

test('shop-local date is correct at 11:30pm local, including across DST transitions', () => {
  // 2026-03-08 is the US spring-forward day (2am -> 3am, EST -> EDT).
  // 11:30pm local that day = 2026-03-08T23:30:00-04:00 = 2026-03-09T03:30:00Z.
  assert.equal(pl.shopLocalDate('2026-03-09T03:30:00Z', TZ), '2026-03-08');

  // 2026-11-01 is the US fall-back day (2am -> 1am, EDT -> EST).
  // 11:30pm local that day = 2026-11-01T23:30:00-05:00 = 2026-11-02T04:30:00Z.
  assert.equal(pl.shopLocalDate('2026-11-02T04:30:00Z', TZ), '2026-11-01');
});

test('an order just past midnight in the shop timezone must bucket by the shop timezone, not any other', () => {
  // 2026-03-10T04:15:00Z is 2026-03-10 00:15 in America/New_York (EDT, -04:00)
  // but still 2026-03-09 21:15 in America/Los_Angeles (PDT, -07:00) — a
  // sheet/display timezone that differs from the shop's would misbucket this
  // order into the previous day.
  const processedAt = '2026-03-10T04:15:00Z';
  const node = baseOrder({
    processedAt,
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '15.00' })] },
  });

  const shopTzOrder = pl.normalizeOrder(node, 'America/New_York');
  assert.equal(shopTzOrder.date, '2026-03-10', 'bucketed by the shop timezone, just past midnight there');

  const wrongTzOrder = pl.normalizeOrder(node, 'America/Los_Angeles');
  assert.equal(wrongTzOrder.date, '2026-03-09', 'a differing timezone would misbucket it to the previous day');
  assert.notEqual(shopTzOrder.date, wrongTzOrder.date);
});

test('shipping cost: per-order vs per-unit', () => {
  const node = baseOrder({
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 4, unitPrice: '15.00' })] },
  });
  const orders = normalizeAll([node]);
  const perOrder = pl.computeRows(orders, baseOptions({ shippingMode: 'per_order', shippingRateCents: 500 }));
  const perUnit = pl.computeRows(orders, baseOptions({ shippingMode: 'per_unit', shippingRateCents: 200 }));
  assert.equal(perOrder.rows.find((r) => r.period === '2026-06').shippingCostCents, 500);
  assert.equal(perUnit.rows.find((r) => r.period === '2026-06').shippingCostCents, 800);
});

test('SKU COGS override beats the default cost', () => {
  const node = baseOrder({
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 3, unitPrice: '15.00' })] },
  });
  const orders = normalizeAll([node]);
  const withDefault = pl.computeRows(orders, baseOptions({ defaultCostCents: 100 }));
  const withOverride = pl.computeRows(orders, baseOptions({ defaultCostCents: 100, costBySku: { 'MUG-01': 400 } }));
  assert.equal(withDefault.rows.find((r) => r.period === '2026-06').cogsCents, 300);
  assert.equal(withOverride.rows.find((r) => r.period === '2026-06').cogsCents, 1200);
});

test('week bucketing groups across a year boundary under the Monday start date', () => {
  const dec30 = baseOrder({
    id: 'o1',
    processedAt: '2025-12-30T14:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '15.00' })] },
  });
  const jan2 = baseOrder({
    id: 'o2',
    processedAt: '2026-01-02T14:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '15.00' })] },
  });
  const { rows } = pl.computeRows(
    normalizeAll([dec30, jan2]),
    baseOptions({ timeframe: 'weekly', startDate: '2025-12-20', endDate: '2026-01-10' })
  );
  const week = rows.find((r) => r.period === '2025-12-29');
  assert.ok(week, 'expected the Monday-2025-12-29 week row to exist');
  assert.equal(week.orders, 2);
  assert.equal(week.grossSalesCents, 3000);
});

test('order #1009: gross/returns/net-sales match Shopify without double-counting the refund', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'order-1009.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const node = fixture.data.orders.nodes[0];
  const normalized = pl.normalizeOrder(node, TZ);

  assert.equal(normalized.units, 3);
  const unitsReturned = normalized.refunds[0].lineItems.reduce((sum, li) => sum + li.quantity, 0);
  assert.equal(unitsReturned, 1);

  const { rows } = pl.computeRows([normalized], baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.grossSalesCents, 5500);
  assert.equal(row.returnsCents, 1500);
  assert.equal(row.netSalesCents, 4000);
});

test('a shipping discount is reflected once, in Shipping charged, not duplicated in Discounts', () => {
  const node = baseOrder({
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '50.00', discounts: ['5.00'] })] },
    shippingLines: { nodes: [shippingLine('8.00')] },
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.grossSalesCents, 5000);
  assert.equal(row.discountsCents, 500);
  assert.equal(row.shippingChargedCents, 800);
  assert.equal(row.netSalesCents, 4500);
});

test('a shipping refund reduces Shipping charged on the refund date, not Returns', () => {
  const node = baseOrder({
    processedAt: '2026-06-15T14:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '50.00' })] },
    shippingLines: { nodes: [shippingLine('10.00')] },
    refunds: [refund({ processedAt: '2026-07-05T14:00:00Z', shippingAmounts: ['4.00'] })],
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const june = rows.find((r) => r.period === '2026-06');
  const july = rows.find((r) => r.period === '2026-07');
  assert.equal(june.shippingChargedCents, 1000);
  assert.equal(june.returnsCents, 0);
  assert.equal(july.shippingChargedCents, -400);
  assert.equal(july.returnsCents, 0);
});

test('a $10 discretionary refund with no line items counts as Returns via orderAdjustments', () => {
  const node = baseOrder({
    processedAt: '2026-06-15T14:00:00Z',
    lineItems: { nodes: [lineItem({ sku: 'MUG-01', quantity: 1, unitPrice: '50.00' })] },
    refunds: [refund({ processedAt: '2026-06-20T14:00:00Z', adjustments: ['10.00'] })],
  });
  const { rows } = pl.computeRows(normalizeAll([node]), baseOptions());
  const row = rows.find((r) => r.period === '2026-06');
  assert.equal(row.returnsCents, 1000);
  assert.equal(row.shippingChargedCents, 0);
  assert.equal(row.cogsCents, 100);
});
