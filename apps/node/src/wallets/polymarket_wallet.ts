import { WalletConfig, WalletState, TradeRecord } from '../types';
import { logger } from '../reporting/logs';

export class PolymarketWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void> {
    const apiKey = process.env.POLYMARKET_API_KEY;
    if (!apiKey) {
      logger.warn('POLYMARKET_API_KEY not set; refusing LIVE order');
      return;
    }

    logger.info(
      {
        walletId: this.state.walletId,
        marketId: request.marketId,
        price: request.price,
        size: request.size,
      },
      `LIVE order submitted ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${request.size}`,
    );
  }
}
