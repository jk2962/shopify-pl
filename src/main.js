/*
 * Entry points only — logic lives in sheet.js (pl.js for pure P/L math,
 * shopify.js for sync).
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('P/L')
    .addItem('Sync now', 'syncNow')
    .addItem('Recalculate', 'recalculateMenu')
    .addItem('Load demo data', 'loadDemoDataMenu')
    .addSeparator()
    .addItem('Set credentials', 'setCredentialsMenu')
    .addItem('Enable hourly sync', 'enableHourlySyncMenu')
    .addToUi();
}

function syncNow() {
  const ui = SpreadsheetApp.getUi();
  try {
    const result = runSync(SpreadsheetApp.getActive());
    let message;
    if (!result.done) {
      message = `Synced ${result.ordersSynced} orders so far, continuing automatically…`;
    } else if (result.ordersSynced === 0) {
      message = 'No new or changed orders since last sync';
    } else {
      message = `Synced ${result.ordersSynced} orders`;
    }
    SpreadsheetApp.getActiveSpreadsheet().toast(message, 'P/L', 5);
  } catch (err) {
    ui.alert('Sync failed', String((err && err.message) || err), ui.ButtonSet.OK);
  }
}

function recalculateMenu() {
  recalculate(SpreadsheetApp.getActive());
  SpreadsheetApp.getActiveSpreadsheet().toast('Recalculated', 'P/L', 3);
}

function loadDemoDataMenu() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  ensureOrdersSheet(ss);
  const hasRealOrders = readOrders(ss).some((o) => !isDemoOrderId(o.id));
  const message = hasRealOrders
    ? 'This Orders tab has real synced Shopify orders. Loading demo data will ERASE them and replace ' +
      'everything with ~120 sample orders. Continue?'
    : 'This replaces everything in the Orders tab with ~120 sample orders. Continue?';
  const response = ui.alert('Load demo data', message, ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;
  loadDemoData(ss);
  ui.alert('Demo data loaded ✅');
}

function setCredentialsMenu() {
  saveShopifyCredentials();
}

function enableHourlySyncMenu() {
  enableHourlySync();
}
