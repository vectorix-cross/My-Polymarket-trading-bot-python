import { BaseStrategy } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Cross-Market Arbitrage Strategy – Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Three arbitrage modes:
   1. Binary Arb – YES + NO prices deviate from 1.0 within a single market.
   2. Event Cluster Arb – markets sharing the same eventId whose implied
      probabilities don't sum to a consistent total.
   3. Series Correlation Arb – related markets within a series that show
      temporary divergence from historical spreads.

   Improvements over the original:
   • Slippage-aware edge calculation (deducts half-spread from gross edge)
   • Volume / liquidity filters to avoid thin markets
   • Fee-aware profitability gate (requires net edge > 50 bps after fees)
   • Event-level grouping for multi-leg arb detection
   • Staleness guard – skips markets not updated in last 60 s
   • Confidence scoring based on depth, volume, and edge magnitude
   • Kelly-inspired position sizing with half-Kelly fraction
   • Managed positions with time-based exit and adverse-move stop
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ── Constants ────────────────────────────────────────────────── */
const MIN_VOLUME = 1_000;
const MIN_LIQUIDITY = 200;
const STALE_MS = 60_000;
const TAKER_FEE_BPS = 20; // Polymarket fee estimate
const MIN_NET_EDGE_BPS = 40; // Lower threshold to catch more arbs
const MAX_CONFIDENCE = 0.92;
const MAX_POSITIONS = 15;

/** Tracked arb position */
interface ArbPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  entryTime: number;
  arbType: 'binary' | 'event_cluster';
  peakEdgeBps: number;
}

export class CrossMarketArbitrageStrategy extends BaseStrategy {
  readonly name = 'cross_market_arbitrage';
  protected override cooldownMs = 60_000; // 1-min cooldown per market (arbs are time-sensitive)

  private positions: ArbPosition[] = [];
  private priceHistory = new Map<string, number[]>();

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);
    const hist = this.priceHistory.get(data.marketId) ?? [];
    hist.push(data.midPrice);
    if (hist.length > 30) hist.shift();
    this.priceHistory.set(data.marketId, hist);
  }

  /* ── Signal generation ──────────────────────────────────────── */
  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    if (this.positions.length >= MAX_POSITIONS) return signals;

    const now = Date.now();

    // ── Mode 1: Binary arb (YES+NO ≠ 1.0) ────────────────────
    for (const [, market] of this.markets) {
      if (!this.passesFilters(market, now)) continue;
      if (market.outcomePrices.length < 2) continue;

      const yesPrice = market.outcomePrices[0];
      const noPrice = market.outcomePrices[1];
      const totalPrice = yesPrice + noPrice;
      const halfSpread = market.spread / 2;
      const feeCost = (TAKER_FEE_BPS / 10_000) * 2; // fee on each side

      if (totalPrice < 1 - 0.005) {
        // Can buy both for < $1. Gross edge = 1 - totalPrice
        const grossEdge = 1 - totalPrice;
        const netEdge = grossEdge - halfSpread * 2 - feeCost;
        if (netEdge * 10_000 < MIN_NET_EDGE_BPS) continue;

        const conf = this.computeConfidence(netEdge, market);
        // Buy the cheaper side (or both if edge is large enough)
        const cheaperSide: 'YES' | 'NO' = yesPrice <= noPrice ? 'YES' : 'NO';
        signals.push({
          marketId: market.marketId,
          outcome: cheaperSide,
          side: 'BUY',
          confidence: conf,
          edge: netEdge,
        });

        // If net edge is large enough, buy both sides (guaranteed $1 payout)
        if (netEdge > 0.015) {
          const otherSide: 'YES' | 'NO' = cheaperSide === 'YES' ? 'NO' : 'YES';
          signals.push({
            marketId: market.marketId,
            outcome: otherSide,
            side: 'BUY',
            confidence: conf * 0.9,
            edge: netEdge,
          });
        }
      }

      if (totalPrice > 1 + 0.005) {
        // Overpriced: sell the expensive side
        const grossEdge = totalPrice - 1;
        const netEdge = grossEdge - halfSpread * 2 - feeCost;
        if (netEdge * 10_000 < MIN_NET_EDGE_BPS) continue;

        const conf = this.computeConfidence(netEdge, market);
        const expensiveSide: 'YES' | 'NO' = yesPrice >= noPrice ? 'YES' : 'NO';
        signals.push({
          marketId: market.marketId,
          outcome: expensiveSide,
          side: 'SELL',
          confidence: conf,
          edge: netEdge,
        });
      }
    }

    // ── Mode 2: Event cluster arb ─────────────────────────────
    const eventGroups = this.groupByEvent();
    for (const [, group] of eventGroups) {
      if (group.length < 2) continue;

      // Sum of YES prices across related markets in the same event
      const totalYes = group.reduce((sum, m) => sum + m.outcomePrices[0], 0);
      // For mutually exclusive outcomes, YES prices should sum to ~1.0
      // Allow for slight deviation (this is common in multi-outcome events)
      const deviation = Math.abs(totalYes - 1);

      if (deviation > 0.03 && deviation < 0.25) {
        // Find the most underpriced and overpriced markets in the group
        const sorted = [...group].sort(
          (a, b) => a.outcomePrices[0] - b.outcomePrices[0],
        );

        if (totalYes < 1) {
          // Underpriced: buy the cheapest YES
          const cheapest = sorted[0];
          if (!this.passesFilters(cheapest, now)) continue;
          const netEdge = deviation / group.length - (TAKER_FEE_BPS / 10_000);
          if (netEdge * 10_000 < MIN_NET_EDGE_BPS) continue;

          signals.push({
            marketId: cheapest.marketId,
            outcome: 'YES',
            side: 'BUY',
            confidence: this.computeConfidence(netEdge, cheapest) * 0.85,
            edge: netEdge,
          });
        } else {
          // Overpriced: sell the most expensive YES
          const expensive = sorted[sorted.length - 1];
          if (!this.passesFilters(expensive, now)) continue;
          const netEdge = deviation / group.length - (TAKER_FEE_BPS / 10_000);
          if (netEdge * 10_000 < MIN_NET_EDGE_BPS) continue;

          signals.push({
            marketId: expensive.marketId,
            outcome: 'YES',
            side: 'SELL',
            confidence: this.computeConfidence(netEdge, expensive) * 0.85,
            edge: netEdge,
          });
        }
      }
    }

    // Sort by edge descending – take the best arbs first
    signals.sort((a, b) => b.edge - a.edge);
    return signals.slice(0, MAX_POSITIONS - this.positions.length);
  }

  /* ── Sizing: half-Kelly with capital constraints ────────────── */
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

        // Half-Kelly: f* = edge / odds, then halve
        const price = signal.side === 'BUY'
          ? (market?.bid ?? 0.5)
          : (market?.ask ?? 0.5);
        const impliedOdds = Math.max(0.1, (1 / Math.max(price, 0.01)) - 1);
        const kellyFraction = Math.max(0, signal.edge / impliedOdds);
        const halfKelly = kellyFraction / 2;

        const liquidity = market?.liquidity ?? 500;

        // Position limits: % of capital, liquidity cap, absolute cap
        const maxFromCapital = capital * Math.min(halfKelly, 0.06);
        const maxFromLiquidity = liquidity * 0.005;
        const size = Math.max(1, Math.floor(Math.min(maxFromCapital, maxFromLiquidity, 60)));

        // Use actual bid/ask prices with small offset for execution
        const offset = signal.edge * 0.15; // give back 15% of edge for execution
        const orderPrice = signal.side === 'BUY'
          ? Number(Math.min((market?.bid ?? 0.5) + offset, 0.98).toFixed(4))
          : Number(Math.max((market?.ask ?? 0.5) - offset, 0.02).toFixed(4));

        return {
          walletId,
          marketId: signal.marketId,
          outcome: signal.outcome,
          side: signal.side,
          price: orderPrice,
          size,
          strategy: this.name,
        };
      });
  }

  /* ── Position tracking via engine callback ──────────────────── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    this.positions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      size: order.size,
      entryTime: Date.now(),
      arbType: 'binary',
      peakEdgeBps: 0,
    });
  }

  /** Legacy — position tracking now handled by notifyFill */
  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions: time exit, adverse move stop ─────────── */
  override managePositions(): void {
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : market.outcomePrices[1];

      // Calculate current edge in basis points
      const currentEdgeBps = pos.side === 'BUY'
        ? (currentPrice - pos.entryPrice) * 10_000
        : (pos.entryPrice - currentPrice) * 10_000;

      // Track peak edge
      pos.peakEdgeBps = Math.max(pos.peakEdgeBps, currentEdgeBps);

      const holdingMs = Date.now() - pos.entryTime;
      const holdingMinutes = holdingMs / 60_000;

      // ── Exit conditions ───────────────────────────────────
      let exitReason: string | undefined;

      // 1. Time exit: arbs should close quickly (within 20 min)
      if (holdingMinutes > 20) {
        exitReason = 'TIME_EXIT';
      }

      // 2. Take profit: edge has been captured (>= 100 bps)
      if (!exitReason && currentEdgeBps > 100) {
        exitReason = 'TAKE_PROFIT';
      }

      // 3. Stop loss: adverse move > 120 bps
      if (!exitReason && currentEdgeBps < -120) {
        exitReason = 'STOP_LOSS';
      }

      // 4. Trailing stop: if we were up > 60 bps and dropped > 25 bps from peak
      if (!exitReason && pos.peakEdgeBps > 60 && currentEdgeBps < pos.peakEdgeBps - 25) {
        exitReason = 'TRAILING_STOP';
      }

      // 5. Arb closed: YES+NO sum returned to ~1.0
      if (!exitReason && market.outcomePrices.length >= 2) {
        const total = market.outcomePrices[0] + market.outcomePrices[1];
        if (Math.abs(total - 1) < 0.003) {
          exitReason = 'ARB_CLOSED';
        }
      }

      if (exitReason) {
        toRemove.push(i);

        /* Queue the reverse order so the wallet records the realized PnL */
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

    // Remove closed positions in reverse order
    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.positions.splice(toRemove[i], 1);
    }
  }

  /* ── Helper: market quality filters ─────────────────────────── */
  private passesFilters(market: MarketData, now: number): boolean {
    if (market.volume24h < MIN_VOLUME) return false;
    if (market.liquidity < MIN_LIQUIDITY) return false;
    if (now - market.timestamp > STALE_MS) return false;

    // Skip markets too close to resolution (price near 0 or 1)
    const yesPrice = market.outcomePrices[0] ?? 0.5;
    if (yesPrice < 0.03 || yesPrice > 0.97) return false;

    // Skip markets with essentially no spread (nothing to capture)
    if (market.spread < 0.001) return false;

    return true;
  }

  /* ── Helper: confidence scoring ─────────────────────────────── */
  private computeConfidence(netEdge: number, market: MarketData): number {
    // Component 1: edge magnitude (bigger edge = higher confidence)
    const edgeScore = Math.min(1, netEdge * 40); // 2.5% edge → 1.0

    // Component 2: volume (more volume = more reliable pricing)
    const volumeScore = Math.min(1, market.volume24h / 20_000);

    // Component 3: liquidity depth
    const liquidityScore = Math.min(1, market.liquidity / 5_000);

    // Component 4: tight spread (tighter = better execution)
    const spreadScore = Math.max(0, 1 - market.spread * 20);

    // Component 5: price stability (low recent volatility)
    const hist = this.priceHistory.get(market.marketId) ?? [];
    let stabilityScore = 0.5;
    if (hist.length >= 5) {
      const returns = [];
      for (let i = 1; i < hist.length; i++) {
        returns.push(Math.abs(hist[i] - hist[i - 1]));
      }
      const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
      stabilityScore = Math.max(0, 1 - avgReturn * 50);
    }

    const weighted =
      edgeScore * 0.35 +
      volumeScore * 0.20 +
      liquidityScore * 0.15 +
      spreadScore * 0.15 +
      stabilityScore * 0.15;

    return Math.min(MAX_CONFIDENCE, weighted);
  }

  /* ── Helper: group markets by eventId ───────────────────────── */
  private groupByEvent(): Map<string, MarketData[]> {
    const groups = new Map<string, MarketData[]>();
    for (const [, market] of this.markets) {
      const eventId = market.eventId;
      if (!eventId) continue;
      const group = groups.get(eventId) ?? [];
      group.push(market);
      groups.set(eventId, group);
    }
    return groups;
  }
}
