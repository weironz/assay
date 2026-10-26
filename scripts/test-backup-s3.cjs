const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateObjectKey } = require('./backup-s3.cjs');

test('filesystem export rejects object keys that escape or alias backup paths', () => {
  for (const key of ['', '/absolute', '../escape', 'tickets/../escape', 'tickets/./alias',
                     'tickets//alias', 'tickets\\escape', 'bad\0key', 'folder/']) {
    assert.throws(() => validateObjectKey(key));
  }
  for (const key of ['tickets/2026/id.png', 'tickets/附件 截图.png', '.hidden/value']) {
    assert.equal(validateObjectKey(key), key);
  }
});
