import { WalletState, TradeRecord } from '../types';

export interface PerformanceSnapshot {
  walletId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeLike: number;
  totalTrades: number;
}

export interface WalletDashboardEntry {
  walletId: string;
  displayName: string;
  mode: 'LIVE' | 'PAPER';
  strategy: string;
  capitalAllocated: number;
  availableBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  paused: boolean;
  openPositions: Array<{
    marketId: string;
    outcome: 'YES' | 'NO';
    size: number;
    avgPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
  }>;
  riskLimits: {
    maxPositionSize: number;
    maxExposurePerMarket: number;
    maxDailyLoss: number;
    maxOpenTrades: number;
    maxDrawdown: number;
  };
  performance: PerformanceSnapshot;
}

export interface DashboardPayload {
  generatedAt: string;
  totalCapital: number;
  totalPnl: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  activeWallets: number;
  wallets: WalletDashboardEntry[];
}

export function computePerformance(
  wallet: WalletState,
  trades: TradeRecord[],
  unrealizedPnl: number,
): PerformanceSnapshot {
  // Compute real win rate from actual trades
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const closedTrades = wins.length + losses.length;
  const winRate = closedTrades > 0 ? wins.length / closedTrades : 0;

  const totalWinPnl = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const totalLossPnl = losses.reduce((s, t) => s + t.realizedPnl, 0);
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;
  const profitFactor =
    losses.length > 0 && totalLossPnl !== 0
      ? Math.abs(totalWinPnl / totalLossPnl)
      : wins.length > 0
        ? Infinity
        : 0;

  // Sharpe-like ratio: PnL / capital
  const totalPnl = wallet.realizedPnl + unrealizedPnl;
  const sharpeLike = Number(
    (totalPnl / Math.max(1, wallet.capitalAllocated)).toFixed(4),
  );

  return {
    walletId: wallet.walletId,
    realizedPnl: wallet.realizedPnl,
    unrealizedPnl,
    totalPnl,
    winRate: Number(winRate.toFixed(4)),
    winCount: wins.length,
    lossCount: losses.length,
    avgWin: Number(avgWin.toFixed(4)),
    avgLoss: Number(avgLoss.toFixed(4)),
    profitFactor: profitFactor === Infinity ? 999 : Number(profitFactor.toFixed(4)),
    sharpeLike,
    totalTrades: trades.length,
  };
}

export function buildDashboardPayload(
  wallets: WalletState[],
  tradesByWallet: Map<string, TradeRecord[]>,
  marketPrices?: Map<string, number>,
  pausedWallets?: Set<string>,
  displayNames?: Map<string, string>,
): DashboardPayload {
  const entries: WalletDashboardEntry[] = wallets.map((w) => {
    const trades = tradesByWallet.get(w.walletId) ?? [];

    // Compute unrealized PnL for each open position (skip zero-size)
    let walletUnrealizedPnl = 0;
    const positions = w.openPositions.filter((p) => p.size > 0).map((p) => {
      // Use live market price if available, otherwise use avgPrice (no unrealized PnL)
      const currentPrice = marketPrices?.get(p.marketId) ?? p.avgPrice;
      const unrealizedPnl =
        p.size > 0 && p.avgPrice > 0
          ? (currentPrice - p.avgPrice) * p.size
          : 0;
      walletUnrealizedPnl += unrealizedPnl;
      return {
        marketId: p.marketId,
        outcome: p.outcome,
        size: Number(p.size.toFixed(4)),
        avgPrice: Number(p.avgPrice.toFixed(4)),
        realizedPnl: Number(p.realizedPnl.toFixed(4)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
      };
    });

    return {
      walletId: w.walletId,
      displayName: displayNames?.get(w.walletId) ?? w.walletId,
      mode: w.mode,
      strategy: w.assignedStrategy,
      capitalAllocated: w.capitalAllocated,
      availableBalance: Number(w.availableBalance.toFixed(4)),
      realizedPnl: Number(w.realizedPnl.toFixed(4)),
      unrealizedPnl: Number(walletUnrealizedPnl.toFixed(4)),
      totalPnl: Number((w.realizedPnl + walletUnrealizedPnl).toFixed(4)),
      paused: pausedWallets?.has(w.walletId) ?? false,
      openPositions: positions,
      riskLimits: w.riskLimits,
      performance: computePerformance(w, trades, walletUnrealizedPnl),
    };
  });

  const totalRealizedPnl = entries.reduce((s, e) => s + e.realizedPnl, 0);
  const totalUnrealizedPnl = entries.reduce((s, e) => s + e.unrealizedPnl, 0);

  return {
    generatedAt: new Date().toISOString(),
    totalCapital: entries.reduce((s, e) => s + e.capitalAllocated, 0),
    totalPnl: Number((totalRealizedPnl + totalUnrealizedPnl).toFixed(4)),
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
    totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(4)),
    activeWallets: entries.length,
    wallets: entries,
  };
}
