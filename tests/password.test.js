const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, generateTempPassword } = require('../src/utils/password');

test('hashPassword produces a hash that verifyPassword can check', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
});

test('generateTempPassword returns a 10-character password', () => {
  const p1 = generateTempPassword();
  const p2 = generateTempPassword();
  assert.equal(p1.length, 10);
  assert.notEqual(p1, p2);
});
