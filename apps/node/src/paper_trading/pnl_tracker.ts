import { Position } from '../types';

export class PnlTracker {
  recordFill(
    fill: {
      marketId: string;
      outcome: 'YES' | 'NO';
      side: 'BUY' | 'SELL';
      price: number;
      size: number;
    },
    position: Position,
    entryPrice: number,
  ): { realized: number } {
    if (fill.side === 'SELL') {
      const realized = (fill.price - entryPrice) * fill.size;
      position.realizedPnl += realized;
      return { realized };
    }
    return { realized: 0 };
  }

  /** Compute unrealized PnL for a position given the current market price */
  static unrealizedPnl(position: Position, currentPrice: number): number {
    if (position.size <= 0 || position.avgPrice === 0) return 0;
    return (currentPrice - position.avgPrice) * position.size;
  }
}
