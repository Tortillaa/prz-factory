import { test } from 'node:test';
import assert from 'node:assert/strict';
import { average } from '../src/cart.mjs';

test('average of two prices', () => {
  assert.equal(average([2, 4]), 3);
});
