import { BaseStrategy } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AI Forecast Strategy – Enhanced Multi-Factor Ensemble
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   A quantitative ensemble strategy that combines multiple independent
   factors, weights them by current market regime, and only fires
   when multiple factors agree.

   Factors:
   1. Momentum – price trend direction & strength (EMA crossover)
   2. Mean-Reversion – deviation from rolling VWAP (z-score)
   3. Volume-Price Divergence – volume surge with stagnant price
   4. Volatility Regime – adapts thresholds based on realized vol
   5. Sentiment Proxy – price change velocity (acceleration)
   6. Liquidity Quality – bid-ask dynamics and depth

   Regime detection:
   • TRENDING: momentum and mean-reversion agree on direction
   • RANGING: low momentum, price oscillates around mean
   • VOLATILE: high realized vol, widen thresholds

   Risk management:
   • Managed positions with trailing stop, time exit, drawdown stop
   • Partial profit taking at milestones
   • Half-Kelly sizing capped at 3% of capital
   • Factor agreement gate: minimum 3 of 6 factors must agree
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const MIN_VOLUME = 1_500;
const MIN_LIQUIDITY = 300;
const MIN_HISTORY = 10;
const MAX_HISTORY = 60;
const PRICE_FLOOR = 0.06;
const PRICE_CEILING = 0.94;
const MAX_POSITIONS = 10;
const MAX_CONFIDENCE = 0.90;

type Regime = 'trending' | 'ranging' | 'volatile';

interface FactorResult {
  direction: 'YES' | 'NO' | 'NEUTRAL';
  strength: number; // 0-1
  name: string;
}

interface ManagedPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  originalSize: number;
  entryTime: number;
  peakBps: number;
  regime: Regime;
  factorCount: number;
  partialTaken: boolean;
}

export class AiForecastStrategy extends BaseStrategy {
  readonly name = 'ai_forecast';
  protected override cooldownMs = 150_000; // 2.5 min

  private priceHistory = new Map<string, number[]>();
  private volumeHistory = new Map<string, number[]>();
  private positions: ManagedPosition[] = [];

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);

    const prices = this.priceHistory.get(data.marketId) ?? [];
    prices.push(data.midPrice);
    if (prices.length > MAX_HISTORY) prices.shift();
    this.priceHistory.set(data.marketId, prices);

    const vols = this.volumeHistory.get(data.marketId) ?? [];
    vols.push(data.volume24h);
    if (vols.length > MAX_HISTORY) vols.shift();
    this.volumeHistory.set(data.marketId, vols);
  }

  /* ── Signal generation ──────────────────────────────────────── */
  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    if (this.positions.length >= MAX_POSITIONS) return signals;

    for (const [marketId, market] of this.markets) {
      if (!this.passesFilters(market)) continue;

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;

      // Detect regime
      const regime = this.detectRegime(prices);

      // Run all factors
      const factors = this.runFactors(marketId, market, prices, volumes, regime);

      // Count agreeing factors
      const yesFactors = factors.filter((f) => f.direction === 'YES');
      const noFactors = factors.filter((f) => f.direction === 'NO');

      const yesStrength = yesFactors.reduce((s, f) => s + f.strength, 0);
      const noStrength = noFactors.reduce((s, f) => s + f.strength, 0);

      // Factor agreement gate: need at least 3 factors agreeing
      const minFactorCount = regime === 'volatile' ? 4 : 3;

      let outcome: 'YES' | 'NO';
      let factorCount: number;
      let totalStrength: number;

      if (yesFactors.length >= minFactorCount && yesStrength > noStrength * 1.3) {
        outcome = 'YES';
        factorCount = yesFactors.length;
        totalStrength = yesStrength;
      } else if (noFactors.length >= minFactorCount && noStrength > yesStrength * 1.3) {
        outcome = 'NO';
        factorCount = noFactors.length;
        totalStrength = noStrength;
      } else {
        continue; // No clear consensus
      }

      // Edge: weighted average factor strength, scaled by agreement ratio
      const agreementRatio = factorCount / factors.length;
      const avgStrength = totalStrength / factorCount;
      const edge = Math.min(0.06, avgStrength * agreementRatio * 0.1);

      // Confidence based on factor count, agreement, and regime
      const regimeBonus = regime === 'trending' ? 0.1 : regime === 'ranging' ? 0.05 : -0.05;
      const confidence = Math.min(
        MAX_CONFIDENCE,
        0.3 + agreementRatio * 0.3 + avgStrength * 0.2 + regimeBonus,
      );

      signals.push({
        marketId,
        outcome,
        side: 'BUY',
        confidence,
        edge,
      });
    }

    signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
    return signals.slice(0, MAX_POSITIONS - this.positions.length);
  }

  /* ── Factor 1: Momentum (EMA crossover) ─────────────────────── */
  private factorMomentum(prices: number[]): FactorResult {
    const emaShort = this.ema(prices, 5);
    const emaLong = this.ema(prices, 15);

    if (emaShort.length < 2 || emaLong.length < 2) {
      return { direction: 'NEUTRAL', strength: 0, name: 'momentum' };
    }

    const currentDiff = emaShort[emaShort.length - 1] - emaLong[emaLong.length - 1];
    const prevDiff = emaShort[emaShort.length - 2] - emaLong[emaLong.length - 2];

    // Strength: how much the crossover is widening
    const strength = Math.min(1, Math.abs(currentDiff) * 30);

    if (currentDiff > 0.001 && currentDiff > prevDiff) {
      return { direction: 'YES', strength, name: 'momentum' };
    } else if (currentDiff < -0.001 && currentDiff < prevDiff) {
      return { direction: 'NO', strength, name: 'momentum' };
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'momentum' };
  }

  /* ── Factor 2: Mean-Reversion (z-score from rolling mean) ──── */
  private factorMeanReversion(prices: number[]): FactorResult {
    const lookback = Math.min(prices.length, 30);
    const recent = prices.slice(-lookback);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, p) => s + (p - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < 0.002) {
      return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
    }

    const current = prices[prices.length - 1];
    const zScore = (current - mean) / stdDev;

    // Mean reversion triggers at |z| > 1.5
    const strength = Math.min(1, Math.max(0, (Math.abs(zScore) - 1) / 2));

    if (zScore > 1.5) {
      // Price is above mean → expect reversion down → NO
      return { direction: 'NO', strength, name: 'mean_reversion' };
    } else if (zScore < -1.5) {
      // Price is below mean → expect reversion up → YES
      return { direction: 'YES', strength, name: 'mean_reversion' };
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
  }

  /* ── Factor 3: Volume-Price Divergence ──────────────────────── */
  private factorVolumePriceDivergence(
    prices: number[],
    volumes: number[],
  ): FactorResult {
    if (prices.length < 5 || volumes.length < 5) {
      return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
    }

    const recentPrices = prices.slice(-5);
    const recentVols = volumes.slice(-5);

    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    const priceChangeAbs = Math.abs(priceChange);

    const volStart = recentVols[0];
    const volEnd = recentVols[recentVols.length - 1];
    const volChange = volStart > 0 ? (volEnd - volStart) / volStart : 0;

    // Volume surging (>15%) but price barely moving (<0.5%)
    if (volChange > 0.15 && priceChangeAbs < 0.005) {
      // Divergence detected – price will likely move in the direction
      // indicated by the volume. Use last price direction as hint.
      const lastMove = prices[prices.length - 1] - prices[prices.length - 2];
      const strength = Math.min(1, volChange * 2);
      if (lastMove > 0) {
        return { direction: 'YES', strength, name: 'vol_price_div' };
      } else if (lastMove < 0) {
        return { direction: 'NO', strength, name: 'vol_price_div' };
      }
    }

    // Volume declining with strong price move → exhaustion, expect reversal
    if (volChange < -0.1 && priceChangeAbs > 0.01) {
      const strength = Math.min(1, priceChangeAbs * 20);
      if (priceChange > 0) {
        return { direction: 'NO', strength: strength * 0.7, name: 'vol_price_div' };
      } else {
        return { direction: 'YES', strength: strength * 0.7, name: 'vol_price_div' };
      }
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
  }

  /* ── Factor 4: Volatility regime filter ─────────────────────── */
  private factorVolatility(prices: number[], regime: Regime): FactorResult {
    // In volatile regimes, use mean-reversion bias (price likely to snap back)
    if (regime === 'volatile') {
      const recent = prices.slice(-5);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const current = prices[prices.length - 1];
      const dev = current - avg;

      if (Math.abs(dev) > 0.01) {
        const strength = Math.min(1, Math.abs(dev) * 20);
        return {
          direction: dev > 0 ? 'NO' : 'YES',
          strength: strength * 0.6, // lower weight in volatile markets
          name: 'volatility',
        };
      }
    }

    // In trending regimes, momentum is confirmed
    if (regime === 'trending') {
      const trend = prices[prices.length - 1] - prices[Math.max(0, prices.length - 10)];
      if (Math.abs(trend) > 0.005) {
        return {
          direction: trend > 0 ? 'YES' : 'NO',
          strength: Math.min(1, Math.abs(trend) * 20) * 0.5,
          name: 'volatility',
        };
      }
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'volatility' };
  }

  /* ── Factor 5: Price Acceleration (sentiment proxy) ─────────── */
  private factorAcceleration(prices: number[]): FactorResult {
    if (prices.length < 6) {
      return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    }

    // First derivative: velocity
    const v1 = prices[prices.length - 1] - prices[prices.length - 3];
    const v2 = prices[prices.length - 3] - prices[prices.length - 5];

    // Second derivative: acceleration
    const acceleration = v1 - v2;
    const absAccel = Math.abs(acceleration);

    if (absAccel < 0.002) {
      return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    }

    const strength = Math.min(1, absAccel * 50);
    return {
      direction: acceleration > 0 ? 'YES' : 'NO',
      strength,
      name: 'acceleration',
    };
  }

  /* ── Factor 6: Liquidity Quality ────────────────────────────── */
  private factorLiquidity(market: MarketData): FactorResult {
    // Asymmetric spread: if bid is closer to mid than ask, buying pressure
    const bidDist = market.midPrice - market.bid;
    const askDist = market.ask - market.midPrice;

    if (bidDist === 0 || askDist === 0) {
      return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
    }

    const ratio = bidDist / askDist;
    // ratio < 1 → bid is closer → buying pressure → YES
    // ratio > 1 → ask is closer → selling pressure → NO

    if (ratio < 0.7) {
      return { direction: 'YES', strength: Math.min(1, (1 - ratio) * 2), name: 'liquidity' };
    } else if (ratio > 1.4) {
      return { direction: 'NO', strength: Math.min(1, (ratio - 1) * 2), name: 'liquidity' };
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
  }

  /* ── Run all factors ────────────────────────────────────────── */
  private runFactors(
    _marketId: string,
    market: MarketData,
    prices: number[],
    volumes: number[],
    regime: Regime,
  ): FactorResult[] {
    return [
      this.factorMomentum(prices),
      this.factorMeanReversion(prices),
      this.factorVolumePriceDivergence(prices, volumes),
      this.factorVolatility(prices, regime),
      this.factorAcceleration(prices),
      this.factorLiquidity(market),
    ];
  }

  /* ── Regime detection ───────────────────────────────────────── */
  private detectRegime(prices: number[]): Regime {
    if (prices.length < 10) return 'ranging';

    // Realized volatility (standard deviation of returns)
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / Math.max(prices[i - 1], 0.01));
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
    const vol = Math.sqrt(variance);

    // Directional bias: cumulative return over lookback
    const cumReturn = (prices[prices.length - 1] - prices[0]) / Math.max(prices[0], 0.01);
    const absReturn = Math.abs(cumReturn);

    if (vol > 0.015) return 'volatile';
    if (absReturn > 0.02 && vol < 0.01) return 'trending';
    return 'ranging';
  }

  /* ── Sizing: half-Kelly capped at 3% ────────────────────────── */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    const capital = this.context?.wallet.availableBalance ?? 100;
    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();

    return signals
      .filter((s) => {
        const key = `${s.marketId}:${s.outcome}:${s.side}`;
        const last = (this as any).tradeCooldowns?.get(key) ?? 0;
        return now - last > this.cooldownMs;
      })
      .map((signal) => {
        const market = this.markets.get(signal.marketId);
        const liquidity = market?.liquidity ?? 500;
        const prices = this.priceHistory.get(signal.marketId) ?? [];
        const regime = this.detectRegime(prices);

        // Kelly: f* = (p*b - q) / b where b = edge-based odds
        const winProb = 0.5 + signal.edge;
        const kellyFrac = Math.max(0, (winProb * 2 - 1)) / 2;

        // Regime adjustment
        const regimeMult = regime === 'trending' ? 1.0 : regime === 'ranging' ? 0.7 : 0.5;

        const maxFromCapital = capital * Math.min(kellyFrac * regimeMult, 0.03);
        const maxFromLiquidity = liquidity * 0.003;
        const size = Math.max(1, Math.floor(Math.min(maxFromCapital, maxFromLiquidity, 40)));

        const price = signal.side === 'BUY'
          ? Number(Math.min(0.5 + signal.edge, market?.bid ?? 0.5).toFixed(4))
          : Number(Math.max(0.5 - signal.edge, market?.ask ?? 0.5).toFixed(4));

        return {
          walletId,
          marketId: signal.marketId,
          outcome: signal.outcome,
          side: signal.side,
          price,
          size,
          strategy: this.name,
        };
      });
  }

  /* ── Position tracking via engine callback ──────────────────── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    const prices = this.priceHistory.get(order.marketId) ?? [];
    const regime = this.detectRegime(prices);

    this.positions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      size: order.size,
      originalSize: order.size,
      entryTime: Date.now(),
      peakBps: 0,
      regime,
      factorCount: 0,
      partialTaken: false,
    });
  }

  /** Legacy — position tracking now handled by notifyFill */
  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions ───────────────────────────────────────── */
  override managePositions(): void {
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : market.outcomePrices[1];

      const edgeBps = pos.side === 'BUY'
        ? (currentPrice - pos.entryPrice) * 10_000
        : (pos.entryPrice - currentPrice) * 10_000;

      pos.peakBps = Math.max(pos.peakBps, edgeBps);
      const holdingMin = (Date.now() - pos.entryTime) / 60_000;

      let exitReason: string | undefined;

      // ── Partial profit: take 50% at +100 bps ──────────────
      if (!pos.partialTaken && edgeBps >= 100) {
        const partialSize = Math.floor(pos.originalSize * 0.5);
        pos.size = pos.size - partialSize;
        pos.partialTaken = true;

        /* Queue partial SELL through the wallet */
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: pos.side === 'BUY' ? 'SELL' : 'BUY',
          price: currentPrice,
          size: partialSize,
          strategy: this.name,
        });
        continue;
      }

      // ── Trailing stop: activates at +60 bps, trails 40 bps ─
      if (pos.peakBps > 60 && edgeBps < pos.peakBps - 40) {
        exitReason = 'TRAILING_STOP';
      }

      // ── Take profit: +150 bps ─────────────────────────────
      if (!exitReason && edgeBps >= 150) { exitReason = 'TAKE_PROFIT'; }

      // ── Stop-loss: -120 bps (wider in volatile regime) ─────
      const stopBps = pos.regime === 'volatile' ? -150 : -120;
      if (!exitReason && edgeBps <= stopBps) { exitReason = 'STOP_LOSS'; }

      // ── Time exit: regime-dependent ────────────────────────
      const maxHoldMin = pos.regime === 'trending' ? 60 : pos.regime === 'ranging' ? 30 : 20;
      if (!exitReason && holdingMin > maxHoldMin) { exitReason = 'TIME_EXIT'; }

      // ── Regime change exit: if regime flipped, tighten stops ─
      if (!exitReason) {
        const prices = this.priceHistory.get(pos.marketId) ?? [];
        const currentRegime = this.detectRegime(prices);
        if (currentRegime !== pos.regime && edgeBps < 20) {
          exitReason = 'REGIME_CHANGE';
        }
      }

      if (exitReason) {
        toRemove.push(i);
        const exitSide: 'BUY' | 'SELL' = pos.side === 'BUY' ? 'SELL' : 'BUY';
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: exitSide,
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.positions.splice(toRemove[i], 1);
    }
  }

  /* ── Helpers ────────────────────────────────────────────────── */

  private ema(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];

    // Seed with SMA
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let prev = sum / period;
    result.push(prev);

    for (let i = period; i < prices.length; i++) {
      const val = prices[i] * k + prev * (1 - k);
      result.push(val);
      prev = val;
    }
    return result;
  }

  private passesFilters(market: MarketData): boolean {
    if (market.volume24h < MIN_VOLUME) return false;
    if (market.liquidity < MIN_LIQUIDITY) return false;
    const yesPrice = market.outcomePrices[0] ?? 0.5;
    if (yesPrice < PRICE_FLOOR || yesPrice > PRICE_CEILING) return false;
    return true;
  }
}
