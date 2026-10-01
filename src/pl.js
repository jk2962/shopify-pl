function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}

function ymd(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function centsFromAmount(amountStr) {
  return Math.round(parseFloat(amountStr) * 100);
}

function moneyBagCents(bag) {
  return centsFromAmount(bag.shopMoney.amount);
}

function shopLocalDate(isoString, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(isoString));
}

function addDaysUTC(dateStr, days) {
  const { y, m, d } = parseYmd(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function weekdayUTC(dateStr) {
  const { y, m, d } = parseYmd(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function mondayOfWeek(dateStr) {
  const dow = weekdayUTC(dateStr);
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDaysUTC(dateStr, diff);
}

function periodKey(dateStr, timeframe) {
  const { y, m } = parseYmd(dateStr);
  switch (timeframe) {
    case 'daily':
      return dateStr;
    case 'weekly':
      return mondayOfWeek(dateStr);
    case 'monthly':
      return `${y}-${pad2(m)}`;
    case 'yearly':
      return `${y}`;
    default:
      throw new Error(`Unknown timeframe: ${timeframe}`);
  }
}

function periodLabel(key, timeframe) {
  return timeframe === 'weekly' ? `Week of ${key}` : key;
}

function generatePeriods(startDate, endDate, timeframe) {
  const keys = [];
  if (timeframe === 'daily') {
    let cur = startDate;
    while (cur <= endDate) {
      keys.push(cur);
      cur = addDaysUTC(cur, 1);
    }
  } else if (timeframe === 'weekly') {
    let cur = mondayOfWeek(startDate);
    const lastMonday = mondayOfWeek(endDate);
    while (cur <= lastMonday) {
      keys.push(cur);
      cur = addDaysUTC(cur, 7);
    }
  } else if (timeframe === 'monthly') {
    const start = parseYmd(startDate);
    const end = parseYmd(endDate);
    let y = start.y;
    let m = start.m;
    while (y < end.y || (y === end.y && m <= end.m)) {
      keys.push(`${y}-${pad2(m)}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  } else if (timeframe === 'yearly') {
    let y = parseYmd(startDate).y;
    const endY = parseYmd(endDate).y;
    while (y <= endY) {
      keys.push(`${y}`);
      y += 1;
    }
  } else {
    throw new Error(`Unknown timeframe: ${timeframe}`);
  }
  return keys;
}

function inRange(dateStr, startDate, endDate) {
  return dateStr >= startDate && dateStr <= endDate;
}

function normalizeRefund(r, timeZone) {
  const date = shopLocalDate(r.processedAt || r.updatedAt, timeZone);

  let merchandiseCents = 0;
  const refundLineItems = ((r.refundLineItems && r.refundLineItems.nodes) || []).map((rli) => {
    merchandiseCents += moneyBagCents(rli.subtotalSet);
    return { sku: rli.lineItem.sku, quantity: rli.quantity };
  });

  let shippingCents = 0;
  for (const rsl of (r.refundShippingLines && r.refundShippingLines.nodes) || []) {
    shippingCents += moneyBagCents(rsl.subtotalAmountSet);
  }

  let discretionaryCents = 0;
  for (const adj of (r.orderAdjustments && r.orderAdjustments.nodes) || []) {
    discretionaryCents += moneyBagCents(adj.amountSet);
  }

  return { date, merchandiseCents, shippingCents, discretionaryCents, lineItems: refundLineItems };
}

function normalizeOrder(node, timeZone) {
  const lineItemNodes = (node.lineItems && node.lineItems.nodes) || [];
  const shippingNodes = (node.shippingLines && node.shippingLines.nodes) || [];
  const refundList = node.refunds || [];

  let grossCents = 0;
  let discountCents = 0;
  let units = 0;
  const lineItems = lineItemNodes.map((li) => {
    const qty = li.quantity;
    const unitPriceCents = centsFromAmount(li.originalUnitPriceSet.shopMoney.amount);
    grossCents += unitPriceCents * qty;
    units += qty;
    for (const alloc of li.discountAllocations || []) {
      discountCents += moneyBagCents(alloc.allocatedAmountSet);
    }
    return { sku: li.sku, quantity: qty, unitPriceCents };
  });

  let shippingChargedCents = 0;
  for (const sl of shippingNodes) {
    shippingChargedCents += moneyBagCents(sl.discountedPriceSet);
  }

  const refunds = refundList.map((r) => normalizeRefund(r, timeZone));

  return {
    id: node.id,
    name: node.name,
    test: node.test === true,
    cancelled: node.cancelledAt !== null,
    counted: node.test === false && node.cancelledAt === null,
    date: shopLocalDate(node.processedAt, timeZone),
    units,
    grossCents,
    discountCents,
    shippingChargedCents,
    lineItems,
    refunds,
  };
}

function costForSku(sku, costBySku, defaultCostCents) {
  if (sku && Object.prototype.hasOwnProperty.call(costBySku, sku)) {
    return costBySku[sku];
  }
  return defaultCostCents;
}

function emptyRow(period, timeframe) {
  return {
    period,
    label: periodLabel(period, timeframe),
    orders: 0,
    units: 0,
    grossSalesCents: 0,
    discountsCents: 0,
    returnsCents: 0,
    shippingChargedCents: 0,
    cogsCents: 0,
    otherExpensesCents: 0,
  };
}

function computeRows(orders, options) {
  const {
    timeframe,
    startDate,
    endDate,
    costBySku = {},
    defaultCostCents,
    shippingMode,
    shippingRateCents,
    feePct,
    feeFixedCents,
    otherExpenses = [],
  } = options;

  const periods = generatePeriods(startDate, endDate, timeframe);
  const rows = new Map();
  for (const p of periods) {
    rows.set(p, emptyRow(p, timeframe));
  }

  for (const order of orders) {
    if (!order.counted) continue;

    if (inRange(order.date, startDate, endDate)) {
      const row = rows.get(periodKey(order.date, timeframe));
      row.orders += 1;
      row.units += order.units;
      row.grossSalesCents += order.grossCents;
      row.discountsCents += order.discountCents;
      row.shippingChargedCents += order.shippingChargedCents;
      for (const li of order.lineItems) {
        row.cogsCents += li.quantity * costForSku(li.sku, costBySku, defaultCostCents);
      }
    }

    for (const refund of order.refunds) {
      if (!inRange(refund.date, startDate, endDate)) continue;
      const row = rows.get(periodKey(refund.date, timeframe));
      row.returnsCents += refund.merchandiseCents + refund.discretionaryCents;
      row.shippingChargedCents -= refund.shippingCents;
      for (const li of refund.lineItems) {
        row.cogsCents -= li.quantity * costForSku(li.sku, costBySku, defaultCostCents);
      }
    }
  }

  for (const expense of otherExpenses) {
    if (!inRange(expense.date, startDate, endDate)) continue;
    rows.get(periodKey(expense.date, timeframe)).otherExpensesCents += expense.amountCents;
  }

  const result = [];
  for (const period of periods) {
    const row = rows.get(period);
    const shippingCostCents =
      shippingMode === 'per_unit' ? shippingRateCents * row.units : shippingRateCents * row.orders;
    const netSalesCents = row.grossSalesCents - row.discountsCents - row.returnsCents;
    const paymentFeesCents = Math.round(
      feePct * (netSalesCents + row.shippingChargedCents) + feeFixedCents * row.orders
    );
    const netProfitCents =
      netSalesCents +
      row.shippingChargedCents -
      row.cogsCents -
      shippingCostCents -
      paymentFeesCents -
      row.otherExpensesCents;
    const revenueBaseCents = netSalesCents + row.shippingChargedCents;
    const marginPct = revenueBaseCents !== 0 ? netProfitCents / revenueBaseCents : null;
    const aovCents = row.orders > 0 ? netSalesCents / row.orders : null;

    result.push({
      period: row.period,
      label: row.label,
      orders: row.orders,
      units: row.units,
      grossSalesCents: row.grossSalesCents,
      discountsCents: row.discountsCents,
      returnsCents: row.returnsCents,
      netSalesCents,
      shippingChargedCents: row.shippingChargedCents,
      cogsCents: row.cogsCents,
      shippingCostCents,
      paymentFeesCents,
      otherExpensesCents: row.otherExpensesCents,
      netProfitCents,
      marginPct,
      aovCents,
    });
  }

  const totals = result.reduce(
    (acc, row) => {
      acc.orders += row.orders;
      acc.units += row.units;
      acc.grossSalesCents += row.grossSalesCents;
      acc.discountsCents += row.discountsCents;
      acc.returnsCents += row.returnsCents;
      acc.netSalesCents += row.netSalesCents;
      acc.shippingChargedCents += row.shippingChargedCents;
      acc.cogsCents += row.cogsCents;
      acc.shippingCostCents += row.shippingCostCents;
      acc.paymentFeesCents += row.paymentFeesCents;
      acc.otherExpensesCents += row.otherExpensesCents;
      acc.netProfitCents += row.netProfitCents;
      return acc;
    },
    {
      period: 'Totals',
      label: 'Totals',
      orders: 0,
      units: 0,
      grossSalesCents: 0,
      discountsCents: 0,
      returnsCents: 0,
      netSalesCents: 0,
      shippingChargedCents: 0,
      cogsCents: 0,
      shippingCostCents: 0,
      paymentFeesCents: 0,
      otherExpensesCents: 0,
      netProfitCents: 0,
    }
  );
  const totalsRevenueBase = totals.netSalesCents + totals.shippingChargedCents;
  totals.marginPct = totalsRevenueBase !== 0 ? totals.netProfitCents / totalsRevenueBase : null;
  totals.aovCents = totals.orders > 0 ? totals.netSalesCents / totals.orders : null;

  return { rows: result, totals };
}

const api = {
  shopLocalDate,
  periodKey,
  periodLabel,
  generatePeriods,
  mondayOfWeek,
  normalizeOrder,
  normalizeRefund,
  computeRows,
  centsFromAmount,
};

if (typeof module !== 'undefined') {
  module.exports = api;
}
