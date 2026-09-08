import { PaperWallet } from './paper_wallet';
import { PolymarketWallet } from './polymarket_wallet';
import { WalletState, WalletConfig, TradeRecord } from '../types';
import { logger } from '../reporting/logs';

import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';

export interface ExecutionWallet {
  getState(): WalletState;
  getTradeHistory(): TradeRecord[];
  placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void>;
  updateBalance(delta: number): void;
  /** Optional display name for the dashboard (defaults to walletId) */
  getDisplayName?(): string;
  setDisplayName?(name: string): void;
  /** Update risk limits at runtime */
  updateRiskLimits?(limits: Partial<import('../types').RiskLimits>): void;
}

export class WalletManager {
  private readonly wallets = new Map<string, ExecutionWallet>();
  private stream?: OrderbookStream;
  private clobFetcher?: ClobFetcher;

  /** Inject real-time dependencies so new PaperWallets can calculate VWAP slippage */
  setPaperDependencies(stream: OrderbookStream, clobFetcher: ClobFetcher): void {
    this.stream = stream;
    this.clobFetcher = clobFetcher;
    logger.info('WalletManager configured with live data dependencies for paper trading VWAP');
  }

  registerWallet(config: WalletConfig, assignedStrategy: string, enableLive: boolean): void {
    if (this.wallets.has(config.id)) {
      throw new Error(`Wallet ${config.id} already registered`);
    }

    if (config.mode === 'LIVE' && !enableLive) {
      logger.warn(
        { walletId: config.id },
        'LIVE trading requested but ENABLE_LIVE_TRADING is false; refusing LIVE wallet',
      );
      return;
    }

    const wallet =
      config.mode === 'LIVE'
        ? new PolymarketWallet(config, assignedStrategy)
        : new PaperWallet(config, assignedStrategy, this.stream, this.clobFetcher);

    this.wallets.set(config.id, wallet);
    const state = wallet.getState();
    logger.info(
      { walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated },
      `Registered wallet ${state.walletId} (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }

  getWallet(walletId: string): ExecutionWallet | undefined {
    return this.wallets.get(walletId);
  }

  listWallets(): WalletState[] {
    return Array.from(this.wallets.values()).map((wallet) => wallet.getState());
  }

  getTradeHistory(walletId: string): TradeRecord[] {
    const wallet = this.wallets.get(walletId);
    if (!wallet) return [];
    return wallet.getTradeHistory();
  }

  getAllTradeHistories(): Map<string, TradeRecord[]> {
    const map = new Map<string, TradeRecord[]>();
    for (const [id, wallet] of this.wallets) {
      map.set(id, wallet.getTradeHistory());
    }
    return map;
  }

  removeWallet(walletId: string): boolean {
    if (!this.wallets.has(walletId)) {
      return false;
    }
    this.wallets.delete(walletId);
    logger.info({ walletId }, `Wallet ${walletId} removed`);
    return true;
  }

  registerExternalWallet(walletId: string, wallet: ExecutionWallet): void {
    if (this.wallets.has(walletId)) {
      throw new Error(`Wallet ${walletId} already registered`);
    }
    this.wallets.set(walletId, wallet);
  }

  addWallet(wallet: ExecutionWallet): void {
    const state = wallet.getState();
    if (this.wallets.has(state.walletId)) {
      throw new Error(`Wallet ${state.walletId} already registered`);
    }
    this.wallets.set(state.walletId, wallet);
    logger.info(
      { walletId: state.walletId, mode: state.mode, strategy: state.assignedStrategy, capital: state.capitalAllocated },
      `Wallet ${state.walletId} added at runtime (${state.mode}) strategy=${state.assignedStrategy}`,
    );
  }
}
