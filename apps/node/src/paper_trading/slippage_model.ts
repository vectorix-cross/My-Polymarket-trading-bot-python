export class SlippageModel {
  /**
   * Apply slippage to a fill price.
   * BUY  → price goes UP   (you pay more)
   * SELL → price goes DOWN  (you receive less)
   */
  apply(price: number, size: number, side: 'BUY' | 'SELL' = 'BUY'): number {
    const slippage = Math.min(0.01, 0.001 * Math.log10(size + 1));
    return side === 'SELL'
      ? price * (1 - slippage)
      : price * (1 + slippage);
  }
}
