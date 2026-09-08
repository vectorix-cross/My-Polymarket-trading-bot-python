import { describe, it, expect } from 'vitest';
import { OrderRouter } from '../src/execution/order_router';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { TradeExecutor } from '../src/execution/trade_executor';
import { WalletManager } from '../src/wallets/wallet_manager';
import { OrderRequest, WalletState } from '../src/types';

class StubWallet {
  public called = false;
  constructor(private state: WalletState) {}
  getState(): WalletState {
    return this.state;
  }
  getTradeHistory() {
    return [];
  }
  updateBalance(): void {
    return;
  }
  async placeOrder(): Promise<void> {
    this.called = true;
  }
}

describe('OrderRouter', () => {
  it('routes orders that pass risk checks', async () => {
    const walletState: WalletState = {
      walletId: 'wallet_1',
      mode: 'PAPER',
      assignedStrategy: 'momentum',
      capitalAllocated: 1000,
      availableBalance: 1000,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: 100,
        maxExposurePerMarket: 200,
        maxDailyLoss: 100,
        maxOpenTrades: 5,
        maxDrawdown: 0.2,
      },
    };

  const manager = new WalletManager();
  const stub = new StubWallet(walletState);
  manager.registerExternalWallet(walletState.walletId, stub);

    const router = new OrderRouter(manager, new RiskEngine(new KillSwitch()), new TradeExecutor());

    const order: OrderRequest = {
      walletId: walletState.walletId,
      marketId: 'POLY-EXAMPLE',
      outcome: 'YES',
      side: 'BUY',
      price: 0.5,
      size: 10,
      strategy: 'momentum',
    };

    await router.route(order);
    expect(stub.called).toBe(true);
  });
});
