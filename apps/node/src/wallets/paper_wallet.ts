import { WalletConfig, WalletState, Position, TradeRecord, RiskLimits } from '../types';
import { FillSimulator } from '../paper_trading/fill_simulator';
import { PnlTracker } from '../paper_trading/pnl_tracker';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';

export class PaperWallet {
  private state: WalletState;
  private readonly fillSimulator: FillSimulator;
  private readonly pnlTracker = new PnlTracker();
  private readonly trades: TradeRecord[] = [];
  private displayName: string = '';

  constructor(
    config: WalletConfig,
    assignedStrategy: string,
    stream?: OrderbookStream,
    clobFetcher?: ClobFetcher
  ) {
    this.displayName = config.id;
    this.fillSimulator = new FillSimulator(stream, clobFetcher);
    this.displayName = config.id;
    this.state = {
      walletId: config.id,
      mode: 'PAPER',
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

  getDisplayName(): string {
    return this.displayName;
  }

  setDisplayName(name: string): void {
    this.displayName = name.trim() || this.state.walletId;
  }

  updateRiskLimits(limits: Partial<RiskLimits>): void {
    if (limits.maxPositionSize !== undefined) this.state.riskLimits.maxPositionSize = limits.maxPositionSize;
    if (limits.maxExposurePerMarket !== undefined) this.state.riskLimits.maxExposurePerMarket = limits.maxExposurePerMarket;
    if (limits.maxDailyLoss !== undefined) this.state.riskLimits.maxDailyLoss = limits.maxDailyLoss;
    if (limits.maxOpenTrades !== undefined) this.state.riskLimits.maxOpenTrades = limits.maxOpenTrades;
    if (limits.maxDrawdown !== undefined) this.state.riskLimits.maxDrawdown = limits.maxDrawdown;
    logger.info({ walletId: this.state.walletId, riskLimits: this.state.riskLimits }, 'Risk limits updated');
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void> {
    const fill = await this.fillSimulator.simulate(request);

    // Capture entry price BEFORE applyFill mutates the position
    // (on full close, applyFill resets avgPrice to 0)
    const existingPos = this.state.openPositions.find(
      (p) => p.marketId === fill.marketId && p.outcome === fill.outcome,
    );
    // For an existing position, use cost basis. For a naked SELL (no prior BUY),
    // entryPrice = 0 so the full proceeds count as realized profit.
    const entryPrice = existingPos ? existingPos.avgPrice : 0;

    const position = this.applyFill(fill);
    const pnl = this.pnlTracker.recordFill(fill, position, entryPrice);
    this.state.realizedPnl += pnl.realized;
    const cost = fill.price * fill.size * (fill.side === 'BUY' ? 1 : -1);
    this.state.availableBalance -= cost;

    // Deduct exact USDC execution fees
    if (fill.feeAsset === 'USDC' && fill.fee > 0) {
      this.state.availableBalance -= fill.fee;
    }

    this.trades.push({
      orderId: fill.orderId,
      walletId: this.state.walletId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      cost: Math.abs(cost),
      fee: fill.fee,
      feeAsset: fill.feeAsset,
      realizedPnl: pnl.realized,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: fill.timestamp,
    });

    const MAX_TRADES = 1000;
    if (this.trades.length > MAX_TRADES) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
    }

    logger.info(
      {
        walletId: this.state.walletId,
        marketId: fill.marketId,
        price: fill.price,
        size: fill.size,
        fee: fill.fee,
        feeAsset: fill.feeAsset
      },
      `${this.state.walletId} PAPER fill ${fill.side} ${fill.outcome} market=${fill.marketId} price=${fill.price} size=${fill.size} fee=${fill.fee} ${fill.feeAsset}`,
    );

    consoleLog.success(
      'FILL',
      `[${this.state.walletId}] ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} (Fee: ${fill.fee.toFixed(4)} ${fill.feeAsset}) → PnL $${pnl.realized.toFixed(2)} | Bal $${this.state.availableBalance.toFixed(2)}`,
      {
        walletId: this.state.walletId,
        strategy: this.state.assignedStrategy,
        orderId: fill.orderId,
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        cost: Math.abs(cost),
        fee: fill.fee,
        feeAsset: fill.feeAsset,
        realizedPnl: Number(pnl.realized.toFixed(4)),
        cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
        balanceAfter: Number(this.state.availableBalance.toFixed(2)),
        openPositions: this.state.openPositions.length,
      }
    );
  }

  private applyFill(fill: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    fee: number;
    feeAsset: 'USDC' | 'SHARES';
  }): Position {
    const existing = this.state.openPositions.find(
      (pos) => pos.marketId === fill.marketId && pos.outcome === fill.outcome,
    );
    if (!existing) {
      if (fill.side === 'SELL') {
        // Selling without a position — return a phantom position, don't add to state
        return {
          marketId: fill.marketId,
          outcome: fill.outcome,
          size: 0,
          avgPrice: fill.price,
          realizedPnl: 0,
        };
      }

      // If opening a new BUY position, deduct the share fee from the acquired size
      let acquiredSize = fill.size;
      if (fill.feeAsset === 'SHARES' && fill.fee > 0) {
        acquiredSize -= fill.fee;
      }

      const position: Position = {
        marketId: fill.marketId,
        outcome: fill.outcome,
        size: acquiredSize,
        avgPrice: fill.price,
        realizedPnl: 0,
      };
      this.state.openPositions.push(position);
      return position;
    }

    if (fill.side === 'BUY') {
      // Adding to position — deduct fee from Acquired Size, update cost basis with weighted average
      let acquiredSize = fill.size;
      if (fill.feeAsset === 'SHARES' && fill.fee > 0) {
        acquiredSize -= fill.fee;
      }

      const newSize = existing.size + acquiredSize;

      // We calculate avgPrice using the gross fill.price and gross fill.size because 
      // the user still "paid" for the total fill amount in USDC. The lost shares are the fee.
      existing.avgPrice =
        (existing.avgPrice * existing.size + fill.price * fill.size) / newSize;
      existing.size = newSize;
    } else {
      // Reducing / closing position — keep avgPrice (cost basis) unchanged
      const reduceQty = Math.min(fill.size, existing.size);
      existing.size -= reduceQty;
      // If fully closed, reset avgPrice
      if (existing.size <= 0) {
        existing.size = 0;
        existing.avgPrice = 0;
      }
      // avgPrice stays the same for partial closes — this is critical for
      // correct realized PnL: (fillPrice − entryPrice) × qty
    }

    // Clean up zero-size positions
    this.state.openPositions = this.state.openPositions.filter(
      (p) => p.size > 0,
    );

    return existing;
  }
}
