const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

test('src/main.js exists', () => {
  assert.ok(fs.existsSync(path.join(srcDir, 'main.js')));
});

test('src/appsscript.json exists and parses', () => {
  const file = path.join(srcDir, 'appsscript.json');
  assert.ok(fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed);
});
