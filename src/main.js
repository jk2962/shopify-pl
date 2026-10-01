/*
 * Entry points only — logic lives in sheet.js (and pl.js for pure P/L math).
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
  SpreadsheetApp.getUi().alert('Not connected yet');
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
  SpreadsheetApp.getUi().alert('Set credentials is not available yet — coming with Shopify sync.');
}

function enableHourlySyncMenu() {
  SpreadsheetApp.getUi().alert('Enable hourly sync is not available yet — coming with Shopify sync.');
}
