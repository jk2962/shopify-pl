function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('P/L')
    .addItem('Setup check', 'setupCheck')
    .addToUi();
}

function setupCheck() {
  SpreadsheetApp.getUi().alert('Connected ✅');
}
