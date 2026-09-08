import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../src/risk/risk_engine';
import { KillSwitch } from '../src/risk/kill_switch';
import { OrderRequest, WalletState } from '../src/types';

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
    maxDailyLoss: 50,
    maxOpenTrades: 5,
    maxDrawdown: 0.2,
  },
};

const order: OrderRequest = {
  walletId: 'wallet_1',
  marketId: 'POLY-EXAMPLE',
  outcome: 'YES',
  side: 'BUY',
  price: 0.5,
  size: 10,
  strategy: 'momentum',
};

describe('RiskEngine', () => {
  it('approves orders within limits', () => {
    const engine = new RiskEngine(new KillSwitch());
    const result = engine.check(order, walletState);
    expect(result.ok).toBe(true);
  });

  it('rejects when kill switch active', () => {
    const killSwitch = new KillSwitch();
    killSwitch.activate();
    const engine = new RiskEngine(killSwitch);
    const result = engine.check(order, walletState);
    expect(result.ok).toBe(false);
  });
});
