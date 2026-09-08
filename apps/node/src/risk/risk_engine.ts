import { OrderRequest, WalletState } from '../types';
import { KillSwitch } from './kill_switch';
import { consoleLog } from '../reporting/console_log';

export class RiskEngine {
  private readonly killSwitch: KillSwitch;

  /** Rolling order timestamps per wallet for rate limiting */
  private orderTimestamps = new Map<string, number[]>();

  /** Cancel counts per wallet (rolling window) */
  private cancelCounts = new Map<string, number[]>();

  /** Total MLE (max loss at resolution) per wallet */
  private walletMle = new Map<string, number>();

  constructor(killSwitch: KillSwitch) {
    this.killSwitch = killSwitch;
  }

  check(order: OrderRequest, wallet: WalletState): { ok: boolean; reason?: string } {
    if (this.killSwitch.isActive()) {
      consoleLog.error('RISK', `KILL SWITCH active — all orders blocked [${order.walletId}]`, {
        walletId: order.walletId,
      });
      return { ok: false, reason: 'Global kill switch active' };
    }

    /* ── Balance check: prevent spending more than available ── */
    if (order.side === 'BUY') {
      const orderCost = order.price * order.size;
      if (orderCost > wallet.availableBalance) {
        return { ok: false, reason: `Insufficient balance: need $${orderCost.toFixed(2)}, have $${wallet.availableBalance.toFixed(2)}` };
      }
    }

    const absSize = Math.abs(order.size);
    if (absSize > wallet.riskLimits.maxPositionSize) {
      return { ok: false, reason: 'Max position size exceeded' };
    }

    if (wallet.openPositions.length >= wallet.riskLimits.maxOpenTrades) {
      return { ok: false, reason: 'Max open trades exceeded' };
    }

    if (wallet.realizedPnl <= -wallet.riskLimits.maxDailyLoss) {
      return { ok: false, reason: 'Max daily loss breached' };
    }

    /* ── Drawdown check ── */
    const drawdownPct = wallet.capitalAllocated > 0
      ? (wallet.capitalAllocated - wallet.availableBalance - this.getTotalUnrealisedValue(wallet)) / wallet.capitalAllocated
      : 0;
    if (drawdownPct > wallet.riskLimits.maxDrawdown) {
      return { ok: false, reason: `Drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds limit ${(wallet.riskLimits.maxDrawdown * 100).toFixed(1)}%` };
    }

    /* ── Per-market MLE check ── */
    const orderCost = order.price * order.size;
    const existingExposure = wallet.openPositions
      .filter((p) => p.marketId === order.marketId)
      .reduce((s, p) => s + Math.abs(p.avgPrice * p.size), 0);
    if (existingExposure + orderCost > wallet.riskLimits.maxExposurePerMarket) {
      return { ok: false, reason: 'Max exposure per market exceeded' };
    }

    /* ── Rate limiting: max orders per minute per wallet ── */
    const rateLimit = wallet.mode === 'PAPER' ? 120 : 20;
    const now = Date.now();
    const stamps = this.orderTimestamps.get(wallet.walletId) ?? [];
    const recentStamps = stamps.filter((t) => now - t < 60_000);
    if (recentStamps.length >= rateLimit) {
      return { ok: false, reason: `Order rate limit (${rateLimit}/min) exceeded` };
    }
    recentStamps.push(now);
    this.orderTimestamps.set(wallet.walletId, recentStamps);

    return { ok: true };
  }

  /** Record a cancel event for rate tracking */
  recordCancel(walletId: string): void {
    const now = Date.now();
    const cancels = this.cancelCounts.get(walletId) ?? [];
    cancels.push(now);
    this.cancelCounts.set(walletId, cancels.filter((t) => now - t < 300_000));
  }

  /** Get the cancel rate over the last 5 minutes */
  getCancelRate(walletId: string): number {
    const now = Date.now();
    const cancels = (this.cancelCounts.get(walletId) ?? []).filter((t) => now - t < 300_000);
    const orders = (this.orderTimestamps.get(walletId) ?? []).filter((t) => now - t < 300_000);
    if (orders.length === 0) return 0;
    return cancels.length / orders.length;
  }

  /** Approximate total unrealised value of open positions */
  private getTotalUnrealisedValue(wallet: WalletState): number {
    return wallet.openPositions.reduce(
      (sum, p) => sum + Math.abs(p.avgPrice * p.size),
      0,
    );
  }
}
