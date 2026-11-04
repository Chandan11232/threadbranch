import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignup } from '../validate.js';

test('accepts a complete signup', () => {
  assert.deepEqual(validateSignup({ name: 'Ada', email: 'ada@example.com', password: 'hunter22' }), []);
});

test('requires every field', () => {
  assert.equal(validateSignup({}).length, 3);
});
