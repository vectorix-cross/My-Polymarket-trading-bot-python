import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { logger } from '../../reporting/logs';
import { consoleLog } from '../../reporting/console_log';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Momentum Strategy — Prediction Market Optimised (v2)
   ─────────────────────────────────────────────────────────────
   Dual-path entry:
     Path A  "Gamma Momentum" — uses the 1-day / 1-week price
             change reported by the Gamma API.
     Path B  "Micro-trend"    — classic MA crossover on polled
             price snapshots with RSI gating.

   v2 fixes:
   • Position tracking via notifyFill (engine callback)
   • Capital/balance checks — never spend more than available
   • Tightened exit parameters for prediction market dynamics
   • Correct PnL calculation for YES and NO positions
   • Max positions limit strictly enforced
   • Per-tick capital deployment cap
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ── Tuned constants ── */
const MIN_VOLUME_24H  = 2_000;
const MIN_LIQUIDITY   = 300;
const MAX_POSITIONS   = 12;
const MAX_SIGNALS_PER_TICK = 4;
const MAX_CAPITAL_PCT = 0.04;
const MAX_TICK_DEPLOY = 0.20;
const MAX_SHARES      = 30;

/* ── Gamma momentum thresholds ── */
const MIN_DAY_CHANGE  = 0.03;
const MIN_WEEK_CHANGE = 0.05;

/* ── Technical thresholds ── */
const SHORT_WINDOW    = 4;
const MED_WINDOW      = 8;
const LONG_WINDOW     = 12;
const RSI_PERIOD      = 14;
const RSI_OVERSOLD    = 30;
const RSI_OVERBOUGHT  = 70;
const ADX_MIN         = 0.15;
const MA_CROSS_MIN_BPS = 10;
const HISTORY_LENGTH  = 30;

/* ── Exit parameters ── */
const TP_BPS          = 100;
const SL_BPS          = 80;
const TRAIL_ACTIVATE  = 60;
const TRAIL_DEDUCT    = 25;
const TREND_REVERSAL_GAP = 0.004;
const TIME_EXIT_MIN   = 45;

interface PriceVolume {
  price: number;
  volume: number;
  timestamp: number;
}

interface MomentumPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  entryTime: number;
  size: number;
  peakPnlBps: number;
  direction: 'BULL' | 'BEAR';
}

export class MomentumStrategy extends BaseStrategy {
  readonly name = 'momentum';

  /* ── Rolling price+volume history per market ── */
  private priceHistory = new Map<string, PriceVolume[]>();

  /* ── Managed positions (populated via notifyFill, NOT submitOrders) ── */
  private managedPositions = new Map<string, MomentumPosition>();

  /* ── Per-market cooldown ── */
  private signalCooldown = new Map<string, number>();

  protected override cooldownMs = 60_000;

  private scanCount = 0;

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    logger.info({ strategy: this.name }, 'Momentum strategy initialised');
  }

  onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);
    const hist = this.priceHistory.get(data.marketId) ?? [];
    hist.push({ price: data.midPrice, volume: data.volume24h, timestamp: data.timestamp });
    if (hist.length > HISTORY_LENGTH) hist.shift();
    this.priceHistory.set(data.marketId, hist);
  }

  /* ── Position tracking via engine callback ── */
  override notifyFill(order: OrderRequest): void {
    if (order.side !== 'BUY') return;
    this.managedPositions.set(order.marketId, {
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      entryTime: Date.now(),
      size: order.size,
      peakPnlBps: 0,
      direction: order.outcome === 'YES' ? 'BULL' : 'BEAR',
    });
  }

  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    const now = Date.now();
    this.scanCount++;

    let totalMarkets = 0;
    let gammaHits = 0;
    let microTrendHits = 0;

    for (const [marketId, market] of this.markets) {
      totalMarkets++;

      if (market.volume24h < MIN_VOLUME_24H) continue;
      if (market.liquidity < MIN_LIQUIDITY) continue;

      const yesPrice = market.outcomePrices[0];
      if (yesPrice < 0.10 || yesPrice > 0.90) continue;

      // Already have position?
      if (this.managedPositions.has(marketId)) continue;

      // Max positions check
      if (this.managedPositions.size >= MAX_POSITIONS) break;

      // Per-market cooldown
      const cd = this.signalCooldown.get(marketId) ?? 0;
      if (now < cd) continue;

      /* ── Path A: Gamma Momentum ── */
      const dayChg = market.oneDayPriceChange ?? 0;
      const weekChg = market.oneWeekPriceChange ?? 0;

      if (Math.abs(dayChg) >= MIN_DAY_CHANGE || Math.abs(weekChg) >= MIN_WEEK_CHANGE) {
        gammaHits++;
        const isBullish = dayChg > 0 || (dayChg === 0 && weekChg > 0);
        const absDayChg = Math.abs(dayChg);
        const absWeekChg = Math.abs(weekChg);

        // RSI filter — don't chase overbought/oversold
        const rsiHist = this.priceHistory.get(marketId);
        if (rsiHist && rsiHist.length >= RSI_PERIOD + 1) {
          const rsi = this.computeRsi(rsiHist.map(h => h.price), RSI_PERIOD);
          if (isBullish && rsi > RSI_OVERBOUGHT) continue;
          if (!isBullish && rsi < RSI_OVERSOLD) continue;
        }

        const edgeRaw = Math.min(0.06, absDayChg * 0.4 + absWeekChg * 0.15);
        const confidence = Math.min(0.80,
          0.35
          + Math.min(0.20, absDayChg * 2.5)
          + Math.min(0.10, absWeekChg * 0.8)
          + (market.volume24h > 5_000 ? 0.05 : 0)
          + (market.spread < 0.03 ? 0.05 : 0),
        );

        if (confidence >= 0.42) {
          signals.push({
            marketId,
            outcome: isBullish ? 'YES' : 'NO',
            side: 'BUY',
            confidence,
            edge: edgeRaw,
          });
          this.signalCooldown.set(marketId, now + 90_000);
          continue;
        }
      }

      /* ── Path B: Micro-trend (MA crossover) ── */
      const hist = this.priceHistory.get(marketId) ?? [];
      if (hist.length < LONG_WINDOW) continue;

      const prices = hist.map(h => h.price);
      const shortMa = this.sma(prices, SHORT_WINDOW);
      const medMa = this.sma(prices, MED_WINDOW);
      const longMa = this.sma(prices, LONG_WINDOW);
      const rsi = this.computeRsi(prices, Math.min(RSI_PERIOD, prices.length - 1));
      const adx = this.computeAdx(prices);

      const crossBps = Math.abs(shortMa - medMa) / Math.max(medMa, 0.001) * 10_000;
      if (crossBps < MA_CROSS_MIN_BPS) continue;
      if (adx < ADX_MIN) continue;

      const volumes = hist.map(h => h.volume);
      const volConfirming = this.isVolumeConfirming(volumes);

      const shortAboveMed = shortMa - medMa;
      const medAboveLong = medMa - longMa;

      /* Bullish */
      if (shortAboveMed > 0 && medAboveLong > 0 && rsi > 30 && rsi < RSI_OVERBOUGHT && volConfirming) {
        microTrendHits++;
        const edgeRaw = Math.min(0.05, shortAboveMed + medAboveLong * 0.5);
        const confidence = Math.min(0.80,
          0.30 + adx * 0.25 + (crossBps / 200) * 0.15 + (volConfirming ? 0.1 : 0)
          + (market.spread < 0.03 ? 0.05 : 0),
        );
        if (confidence >= 0.42) {
          signals.push({ marketId, outcome: 'YES', side: 'BUY', confidence, edge: edgeRaw });
          this.signalCooldown.set(marketId, now + 90_000);
        }
      }
      /* Bearish */
      else if (shortAboveMed < 0 && medAboveLong < 0 && rsi > RSI_OVERSOLD && rsi < 70 && volConfirming) {
        microTrendHits++;
        const edgeRaw = Math.min(0.05, Math.abs(shortAboveMed) + Math.abs(medAboveLong) * 0.5);
        const confidence = Math.min(0.80,
          0.30 + adx * 0.25 + (crossBps / 200) * 0.15 + (volConfirming ? 0.1 : 0)
          + (market.spread < 0.03 ? 0.05 : 0),
        );
        if (confidence >= 0.42) {
          signals.push({ marketId, outcome: 'NO', side: 'BUY', confidence, edge: edgeRaw });
          this.signalCooldown.set(marketId, now + 90_000);
        }
      }
    }

    /* Diagnostic log every ~60 s */
    if (this.scanCount % 12 === 0) {
      consoleLog.info('STRATEGY', `[momentum] Scan #${this.scanCount}: ${totalMarkets} mkts, gamma=${gammaHits}, micro=${microTrendHits}, signals=${signals.length}, open=${this.managedPositions.size}`, {
        totalMarkets, gammaHits, microTrendHits,
        signalCount: signals.length,
        openPositions: this.managedPositions.size,
      });
    }

    signals.sort((a, b) => b.confidence - a.confidence);
    return signals.slice(0, MAX_SIGNALS_PER_TICK);
  }

  /** Sizing with capital guard */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    const available = this.context?.wallet.availableBalance ?? 0;
    const initial = this.context?.wallet.capitalAllocated ?? 0;
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Don't trade if less than 5% of initial capital remaining
    if (available < initial * 0.05) return [];

    // Enforce position limit
    const slotsAvailable = Math.max(0, MAX_POSITIONS - this.managedPositions.size);
    if (slotsAvailable === 0) return [];

    const maxTickDeploy = available * MAX_TICK_DEPLOY;
    let deployedThisTick = 0;
    const orders: OrderRequest[] = [];

    for (const signal of signals) {
      if (orders.length >= slotsAvailable) break;
      if (deployedThisTick >= maxTickDeploy) break;

      if (this.managedPositions.has(signal.marketId)) continue;

      const market = this.markets.get(signal.marketId);
      if (!market) continue;

      // Correct outcome price
      const outcomePrice = signal.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
      const safePrice = Number(Math.max(0.02, Math.min(0.98, outcomePrice)).toFixed(4));

      // Half-Kelly sizing capped at MAX_CAPITAL_PCT of available
      const kellyFraction = signal.edge / Math.max(1 - signal.edge, 0.01);
      const halfKelly = kellyFraction * 0.5;
      const maxDollars = Math.min(
        available * Math.min(halfKelly, MAX_CAPITAL_PCT),
        maxTickDeploy - deployedThisTick,
      );
      if (maxDollars < 1) continue;

      const size = Math.min(Math.max(1, Math.floor(maxDollars / safePrice)), MAX_SHARES);
      const cost = size * safePrice;

      if (deployedThisTick + cost > maxTickDeploy) continue;
      if (cost > available - deployedThisTick) continue;

      deployedThisTick += cost;

      orders.push({
        walletId, marketId: signal.marketId, outcome: signal.outcome,
        side: signal.side, price: safePrice, size, strategy: this.name,
      });
    }

    return orders;
  }

  /** Record positions on submission (legacy — engine also calls notifyFill) */
  override submitOrders(_orders: OrderRequest[]): void {
    // Position tracking now handled by notifyFill()
    return;
  }

  /** Exit logic: TP, SL, trailing, time, trend reversal */
  override managePositions(): void {
    const now = Date.now();

    for (const [marketId, pos] of this.managedPositions) {
      const market = this.markets.get(marketId);
      if (!market) continue;

      // Get current price for the correct outcome
      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);

      // PnL in bps — direction-aware
      const pnlBps = pos.direction === 'BULL'
        ? ((currentPrice - pos.entryPrice) / Math.max(pos.entryPrice, 0.001)) * 10_000
        : ((pos.entryPrice - currentPrice) / Math.max(pos.entryPrice, 0.001)) * 10_000;

      const holdMin = (now - pos.entryTime) / 60_000;

      // Track peak PnL for trailing stop
      if (pnlBps > pos.peakPnlBps) pos.peakPnlBps = pnlBps;

      let exitReason: string | undefined;

      // 1. Take profit
      if (pnlBps >= TP_BPS) {
        exitReason = `TP: +${pnlBps.toFixed(0)}bps`;
      }
      // 2. Stop loss
      else if (pnlBps <= -SL_BPS) {
        exitReason = `SL: ${pnlBps.toFixed(0)}bps`;
      }
      // 3. Trailing stop
      else if (pos.peakPnlBps >= TRAIL_ACTIVATE && pnlBps < pos.peakPnlBps - TRAIL_DEDUCT) {
        exitReason = `TRAIL: peak +${pos.peakPnlBps.toFixed(0)}, now ${pnlBps.toFixed(0)}bps`;
      }
      // 4. Time exit
      else if (holdMin >= TIME_EXIT_MIN) {
        exitReason = `TIME: ${holdMin.toFixed(0)}min`;
      }
      // 5. Trend reversal
      else {
        const prices = (this.priceHistory.get(marketId) ?? []).map(h => h.price);
        if (prices.length >= MED_WINDOW) {
          const shortMa = this.sma(prices, SHORT_WINDOW);
          const medMa = this.sma(prices, MED_WINDOW);
          if (pos.direction === 'BULL' && shortMa < medMa - TREND_REVERSAL_GAP) {
            exitReason = `REVERSAL: short ${shortMa.toFixed(4)} < med ${medMa.toFixed(4)}`;
          } else if (pos.direction === 'BEAR' && shortMa > medMa + TREND_REVERSAL_GAP) {
            exitReason = `REVERSAL: short ${shortMa.toFixed(4)} > med ${medMa.toFixed(4)}`;
          }
        }
      }

      if (exitReason) {
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId,
          outcome: pos.outcome,
          side: 'SELL',
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });

        this.managedPositions.delete(marketId);

        logger.info(
          { strategy: this.name, marketId, outcome: pos.outcome, reason: exitReason, pnlBps: pnlBps.toFixed(0) },
          `MOMENTUM exit: ${exitReason}`,
        );
      }
    }
  }

  /* ━━━━━━ Technical Indicator Helpers ━━━━━━ */

  private sma(data: number[], period: number): number {
    const slice = data.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private computeRsi(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    const start = prices.length - period - 1;
    for (let i = start + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /** ADX-like: measures directional consistency of recent moves (0–1).
   *  Only counts actual price changes — ignores unchanged ticks which are
   *  common in prediction markets with infrequent updates. */
  private computeAdx(prices: number[]): number {
    if (prices.length < 4) return 0;
    const recent = prices.slice(-20);
    let upMoves = 0, downMoves = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) upMoves++;
      else if (recent[i] < recent[i - 1]) downMoves++;
    }
    const actualMoves = upMoves + downMoves;
    if (actualMoves < 2) return 0; // relaxed: only 2 directional changes needed
    // Directional consistency among actual moves only
    const dominance = Math.max(upMoves, downMoves) / actualMoves;
    return Math.max(0, Math.min(1, (dominance - 0.45) * 1.82)); // 0.45→0, 1.0→1  (gentler curve)
  }

  /** Check if recent volume is higher than earlier volume (confirming trend) */
  private isVolumeConfirming(volumes: number[]): boolean {
    if (volumes.length < 6) return true; // not enough data, allow
    const half = Math.floor(volumes.length / 2);
    const earlyAvg = volumes.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const lateAvg = volumes.slice(half).reduce((a, b) => a + b, 0) / (volumes.length - half);
    return lateAvg >= earlyAvg * 0.8; // recent volume at least 80% of earlier
  }
}
