/*
 * Reads Settings/COGS/Other Expenses, reads/writes Orders, writes P/L.
 * Calls pl.js's computeRows() as a bare global (Apps Script shares one
 * global scope across files in a project — no require/import there).
 * No Shopify calls here; recalculate() only ever reads the Orders tab.
 */

const SHEETS = {
  SETTINGS: 'Settings',
  COGS: 'COGS by SKU',
  EXPENSES: 'Other Expenses',
  ORDERS: 'Orders',
  PL: 'P/L',
};

const PL_CONTROLS_ROW = 2;
const PL_BANNER_ROW = 3;
const PL_HEADER_ROW = 4;
const PL_DATA_START_ROW = 5;
const ORDERS_HEADER_ROW = 2;
const ORDERS_DATA_START_ROW = 3;

const PL_COLUMNS = [
  'Period', 'Orders', 'Units', 'Gross sales', 'Discounts', 'Returns', 'Net sales',
  'Shipping charged', 'COGS', 'Shipping cost', 'Payment fees', 'Other expenses',
  'Net profit', 'Margin %', 'AOV',
];
const NET_PROFIT_COL = 13;

const ORDERS_COLUMNS = [
  'Order ID', 'Name', 'Date', 'Test', 'Cancelled', 'Units', 'Gross Sales',
  'Discounts', 'Shipping Charged', 'Line Items (JSON)', 'Refunds (JSON)',
];

const PL_NOTE =
  'How numbers are calculated: bucketed by this sheet’s timezone, weeks start Monday. ' +
  'Cancelled and test orders are excluded. Taxes are excluded throughout. Refunds are dated ' +
  'to the refund, not the original order. COGS = units × per-SKU cost (falls back to the ' +
  'Settings default); refunded units reverse COGS on the refund date. ' +
  'Margin % = Net profit ÷ (Net sales + Shipping charged).';

function dollarsToCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function centsToDollars(cents) {
  return Math.round(cents) / 100;
}

function toDateString(value, timeZone) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  }
  return String(value || '').trim();
}

function clearRange(sheet, startRow, numCols) {
  const lastRow = Math.max(sheet.getMaxRows(), startRow);
  sheet.getRange(startRow, 1, lastRow - startRow + 1, numCols).clearContent();
}

function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ---- Settings ----

function ensureSettingsSheet(ss) {
  const sheet = getOrCreateSheet(ss, SHEETS.SETTINGS);
  if (sheet.getRange('A1').getValue() === 'Setting') return sheet;
  sheet.clear();
  sheet.getRange('A1:C1').setValues([['Setting', 'Value', 'Notes']]);
  sheet.getRange('A2:C6').setValues([
    ['Default COGS per unit', 1.0, ''],
    ['Shipping cost', 5.0, ''],
    ['Shipping cost mode', 'per order', 'per order or per unit'],
    ['Payment fee %', 2.9, 'estimate, edit to match your plan'],
    ['Payment fee fixed per order', 0.3, 'estimate, edit to match your plan'],
  ]);
  sheet
    .getRange('B4')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['per order', 'per unit'], true).build());
  sheet.getRange('A1:A6').setFontWeight('bold');
  sheet.autoResizeColumns(1, 3);
  return sheet;
}

function readSettings(ss) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const [cogs, shipRate, shipMode, feePctPercent, feeFixed] = sheet
    .getRange('B2:B6')
    .getValues()
    .map((r) => r[0]);
  return {
    defaultCostCents: dollarsToCents(cogs),
    shippingRateCents: dollarsToCents(shipRate),
    shippingMode: String(shipMode).trim() === 'per unit' ? 'per_unit' : 'per_order',
    feePct: Number(feePctPercent) / 100,
    feeFixedCents: dollarsToCents(feeFixed),
  };
}

// ---- COGS by SKU ----

function ensureCogsSheet(ss) {
  const sheet = getOrCreateSheet(ss, SHEETS.COGS);
  if (sheet.getRange('A1').getValue() === 'SKU') return sheet;
  sheet.clear();
  sheet.getRange('A1:C1').setValues([['SKU', 'Cost per unit', 'Notes']]);
  sheet.getRange('C2').setValue('Blank cost = use the Settings default');
  sheet.getRange('A1:C1').setFontWeight('bold');
  sheet.autoResizeColumns(1, 3);
  return sheet;
}

function readCogsOverrides(ss) {
  const sheet = ss.getSheetByName(SHEETS.COGS);
  const lastRow = sheet.getLastRow();
  const overrides = {};
  if (lastRow < 2) return overrides;
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (const [sku, cost] of values) {
    if (!sku || cost === '' || cost === null) continue;
    overrides[String(sku).trim()] = dollarsToCents(cost);
  }
  return overrides;
}

// ---- Other Expenses ----

function ensureExpensesSheet(ss) {
  const sheet = getOrCreateSheet(ss, SHEETS.EXPENSES);
  if (sheet.getRange('A1').getValue() === 'Date') return sheet;
  sheet.clear();
  sheet.getRange('A1:C1').setValues([['Date', 'Category', 'Amount']]);
  sheet.getRange('A1:C1').setFontWeight('bold');
  sheet.getRange('A2:A1000').setNumberFormat('yyyy-mm-dd');
  sheet.autoResizeColumns(1, 3);
  return sheet;
}

function readExpenses(ss) {
  const sheet = ss.getSheetByName(SHEETS.EXPENSES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const tz = ss.getSpreadsheetTimeZone();
  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  const expenses = [];
  for (const [date, category, amount] of values) {
    if (!date || amount === '' || amount === null) continue;
    expenses.push({
      date: toDateString(date, tz),
      category: String(category || ''),
      amountCents: dollarsToCents(amount),
    });
  }
  return expenses;
}

// ---- Orders ----

function ensureOrdersSheet(ss) {
  const sheet = getOrCreateSheet(ss, SHEETS.ORDERS);
  if (sheet.getRange('A1').getValue() === 'Script-managed — do not edit') return sheet;
  sheet.clear();
  sheet.getRange('A1').setValue('Script-managed — do not edit');
  sheet.getRange(ORDERS_HEADER_ROW, 1, 1, ORDERS_COLUMNS.length).setValues([ORDERS_COLUMNS]);
  sheet.getRange(ORDERS_HEADER_ROW, 1, 1, ORDERS_COLUMNS.length).setFontWeight('bold');
  sheet.autoResizeColumns(1, ORDERS_COLUMNS.length);
  return sheet;
}

function writeOrders(ss, orders) {
  const sheet = ensureOrdersSheet(ss);
  clearRange(sheet, ORDERS_DATA_START_ROW, ORDERS_COLUMNS.length);
  if (orders.length === 0) return;
  const rows = orders.map((o) => [
    o.id,
    o.name,
    o.date,
    o.test,
    o.cancelled,
    o.units,
    centsToDollars(o.grossCents),
    centsToDollars(o.discountCents),
    centsToDollars(o.shippingChargedCents),
    JSON.stringify(o.lineItems),
    JSON.stringify(o.refunds),
  ]);
  sheet.getRange(ORDERS_DATA_START_ROW, 1, rows.length, ORDERS_COLUMNS.length).setValues(rows);
}

function readOrders(ss) {
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < ORDERS_DATA_START_ROW) return [];
  const tz = ss.getSpreadsheetTimeZone();
  const values = sheet.getRange(ORDERS_DATA_START_ROW, 1, lastRow - ORDERS_DATA_START_ROW + 1, ORDERS_COLUMNS.length).getValues();
  return values
    .filter((row) => row[0])
    .map((row) => {
      const [id, name, date, test, cancelled, units, gross, discounts, shippingCharged, lineItemsJson, refundsJson] = row;
      return {
        id,
        name,
        date: toDateString(date, tz),
        test: test === true,
        cancelled: cancelled === true,
        counted: test === false && cancelled === false,
        units: Number(units),
        grossCents: dollarsToCents(gross),
        discountCents: dollarsToCents(discounts),
        shippingChargedCents: dollarsToCents(shippingCharged),
        lineItems: lineItemsJson ? JSON.parse(lineItemsJson) : [],
        refunds: refundsJson ? JSON.parse(refundsJson) : [],
      };
    });
}

function mergeOrdersById(existingOrders, incomingOrders) {
  const byId = new Map();
  for (const order of existingOrders) byId.set(order.id, order);
  for (const order of incomingOrders) byId.set(order.id, order);
  return Array.from(byId.values());
}

function upsertOrders(ss, incomingOrders) {
  const merged = mergeOrdersById(readOrders(ss), incomingOrders);
  writeOrders(ss, merged);
}

// ---- P/L ----

function ensurePlSheet(ss) {
  const sheet = getOrCreateSheet(ss, SHEETS.PL);
  if (sheet.getRange('A1').getValue() === PL_NOTE) return sheet;
  sheet.clear();
  sheet.getRange('A1').setValue(PL_NOTE);
  sheet.getRange('A1:O1').merge().setWrap(true).setFontStyle('italic');

  sheet.getRange('A2:F2').setValues([['Timeframe', 'Monthly', 'Start date', '', 'End date', '']]);
  sheet.getRange('A2').setFontWeight('bold');
  sheet.getRange('C2').setFontWeight('bold');
  sheet.getRange('E2').setFontWeight('bold');
  sheet
    .getRange('B2')
    .setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(['Daily', 'Weekly', 'Monthly', 'Yearly'], true).build()
    );

  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 14, today.getUTCDate()));
  sheet.getRange('D2').setValue(start).setNumberFormat('yyyy-mm-dd');
  sheet.getRange('F2').setValue(today).setNumberFormat('yyyy-mm-dd');

  sheet.getRange(PL_HEADER_ROW, 1, 1, PL_COLUMNS.length).setValues([PL_COLUMNS]);
  sheet.getRange(PL_HEADER_ROW, 1, 1, PL_COLUMNS.length).setFontWeight('bold');

  const negativeProfitRule = SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0)
    .setFontColor('#CC0000')
    .setRanges([sheet.getRange(PL_DATA_START_ROW, NET_PROFIT_COL, 1000, 1)])
    .build();
  sheet.setConditionalFormatRules([negativeProfitRule]);

  sheet.autoResizeColumns(1, PL_COLUMNS.length);
  return sheet;
}

const READ_ALL_ORDERS_BANNER_TEXT =
  'Only the last 60 days of orders are available — yearly/older figures are incomplete.';

function setReadAllOrdersBanner(ss, hasReadAllOrders) {
  const sheet = ensurePlSheet(ss);
  const range = sheet.getRange(PL_BANNER_ROW, 1, 1, PL_COLUMNS.length);
  if (hasReadAllOrders) {
    range.breakApart();
    range.clearContent();
    range.setBackground(null);
    return;
  }
  range.breakApart();
  sheet.getRange(PL_BANNER_ROW, 1, 1, PL_COLUMNS.length).merge();
  sheet.getRange(PL_BANNER_ROW, 1).setValue(READ_ALL_ORDERS_BANNER_TEXT);
  range.setBackground('#CC0000').setFontColor('#FFFFFF').setFontWeight('bold').setWrap(true);
}

function readPlControls(ss) {
  const sheet = ss.getSheetByName(SHEETS.PL);
  const tz = ss.getSpreadsheetTimeZone();
  return {
    timeframe: String(sheet.getRange('B2').getValue() || 'Monthly').toLowerCase(),
    startDate: toDateString(sheet.getRange('D2').getValue(), tz),
    endDate: toDateString(sheet.getRange('F2').getValue(), tz),
  };
}

function plRowToValues(row) {
  return [
    row.label,
    row.orders,
    row.units,
    centsToDollars(row.grossSalesCents),
    centsToDollars(row.discountsCents),
    centsToDollars(row.returnsCents),
    centsToDollars(row.netSalesCents),
    centsToDollars(row.shippingChargedCents),
    centsToDollars(row.cogsCents),
    centsToDollars(row.shippingCostCents),
    centsToDollars(row.paymentFeesCents),
    centsToDollars(row.otherExpensesCents),
    centsToDollars(row.netProfitCents),
    row.marginPct === null ? '' : row.marginPct,
    row.aovCents === null ? '' : centsToDollars(row.aovCents),
  ];
}

function writePlRows(ss, rows, totals) {
  const sheet = ss.getSheetByName(SHEETS.PL);
  clearRange(sheet, PL_DATA_START_ROW, PL_COLUMNS.length);

  const values = rows.map(plRowToValues);
  values.push(plRowToValues(totals));
  sheet.getRange(PL_DATA_START_ROW, 1, values.length, PL_COLUMNS.length).setValues(values);

  const moneyCols = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15];
  for (const col of moneyCols) {
    sheet.getRange(PL_DATA_START_ROW, col, values.length, 1).setNumberFormat('$#,##0.00');
  }
  sheet.getRange(PL_DATA_START_ROW, 14, values.length, 1).setNumberFormat('0.0%');

  const totalsRow = PL_DATA_START_ROW + values.length - 1;
  sheet.getRange(totalsRow, 1, 1, PL_COLUMNS.length).setFontWeight('bold');
}

// ---- Orchestration ----

function ensureSheets(ss) {
  ensureSettingsSheet(ss);
  ensureCogsSheet(ss);
  ensureExpensesSheet(ss);
  ensureOrdersSheet(ss);
  ensurePlSheet(ss);
  return ss;
}

function recalculate(ss) {
  ensureSheets(ss);
  const settings = readSettings(ss);
  const costBySku = readCogsOverrides(ss);
  const otherExpenses = readExpenses(ss);
  const orders = readOrders(ss);
  const controls = readPlControls(ss);

  const { rows, totals } = computeRows(orders, {
    timeframe: controls.timeframe,
    startDate: controls.startDate,
    endDate: controls.endDate,
    costBySku,
    defaultCostCents: settings.defaultCostCents,
    shippingMode: settings.shippingMode,
    shippingRateCents: settings.shippingRateCents,
    feePct: settings.feePct,
    feeFixedCents: settings.feeFixedCents,
    otherExpenses,
  });

  writePlRows(ss, rows, totals);
}

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  const isPlControlEdit = sheetName === SHEETS.PL && e.range.getRow() === PL_CONTROLS_ROW;
  const watched = sheetName === SHEETS.SETTINGS || sheetName === SHEETS.COGS || sheetName === SHEETS.EXPENSES;
  if (!watched && !isPlControlEdit) return;
  recalculate(sheet.getParent());
}

// ---- Demo data ----

const DEMO_SKUS = [
  { sku: 'TSHIRT-BLK-M', priceCents: 2500 },
  { sku: 'TSHIRT-BLK-L', priceCents: 2500 },
  { sku: 'HOODIE-GRY-M', priceCents: 5500 },
  { sku: 'CAP-NAVY', priceCents: 1800 },
  { sku: 'TOTE-CANVAS', priceCents: 1200 },
];

function demoIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function demoAddDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function buildDemoOrders() {
  const totalOrders = 120;
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 14, today.getUTCDate()));
  const spanDays = Math.round((today.getTime() - start.getTime()) / 86400000);
  const cancelledIndex = 13;
  const testIndex = 47;

  const orders = [];
  for (let i = 0; i < totalOrders; i++) {
    const dayOffset = Math.floor((i / (totalOrders - 1)) * spanDays);
    const orderDate = demoAddDays(start, dayOffset);
    const skuCount = 1 + (i % 3);
    const lineItems = [];
    let grossCents = 0;
    let units = 0;
    for (let li = 0; li < skuCount; li++) {
      const pick = DEMO_SKUS[(i + li) % DEMO_SKUS.length];
      const qty = 1 + ((i + li) % 3);
      lineItems.push({ sku: pick.sku, quantity: qty, unitPriceCents: pick.priceCents });
      grossCents += pick.priceCents * qty;
      units += qty;
    }

    let discountCents = 0;
    if (i % 5 === 0) {
      discountCents = Math.round(lineItems[0].unitPriceCents * lineItems[0].quantity * 0.1);
    }

    const shippingChargedCents = i % 10 === 0 ? 0 : 500;

    const refunds = [];
    if (i % 20 === 7 && i !== cancelledIndex && i !== testIndex) {
      const refundLine = lineItems[0];
      refunds.push({
        date: demoIsoDate(demoAddDays(orderDate, 21)),
        merchandiseCents: refundLine.unitPriceCents,
        shippingCents: 0,
        discretionaryCents: 0,
        lineItems: [{ sku: refundLine.sku, quantity: 1 }],
      });
    }

    orders.push({
      id: `demo-${i + 1}`,
      name: `#${1000 + i}`,
      date: demoIsoDate(orderDate),
      test: i === testIndex,
      cancelled: i === cancelledIndex,
      units,
      grossCents,
      discountCents,
      shippingChargedCents,
      lineItems,
      refunds,
    });
  }
  return orders;
}

function loadDemoData(ss) {
  ensureSheets(ss);
  writeOrders(ss, buildDemoOrders());
  recalculate(ss);
}

if (typeof module !== 'undefined') {
  module.exports = { buildDemoOrders, dollarsToCents, centsToDollars, mergeOrdersById };
}
