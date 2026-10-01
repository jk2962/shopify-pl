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
    const message = result.done
      ? `Sync complete — ${result.ordersSynced} orders updated this pass`
      : `Syncing — ${result.ordersSynced} orders so far, continuing automatically…`;
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
  const response = ui.alert(
    'Load demo data',
    'This replaces everything in the Orders tab with ~120 sample orders. Continue?',
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;
  loadDemoData(SpreadsheetApp.getActive());
  ui.alert('Demo data loaded ✅');
}

function setCredentialsMenu() {
  saveShopifyCredentials();
}

function enableHourlySyncMenu() {
  enableHourlySync();
}
