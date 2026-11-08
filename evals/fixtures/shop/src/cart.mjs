// Average price of the items in a cart.
export function average(prices) {
  return prices.reduce((sum, p) => sum + p, 0) / prices.length;
}
