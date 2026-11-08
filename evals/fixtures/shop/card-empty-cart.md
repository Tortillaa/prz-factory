## Problem
The cart page shows "NaN" as the average price when the cart is empty.

## Context
- **Where:** `src/cart.mjs`, function `average`
- **Who:** every shopper with an empty cart

## Fix
Return 0 for an empty list of prices.

## Acceptance Criteria
- [ ] `average([])` returns `0`
- [ ] `average([2, 4])` still returns `3`
- [ ] A test in `test/` asserts the empty case

## Risk
🟢 **Low** · one pure function, covered by tests
