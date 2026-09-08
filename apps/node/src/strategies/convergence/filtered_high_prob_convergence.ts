import { BaseStrategy, StrategyContext } from '../strategy_interface';
import {
  ConvergenceConfig,
  MarketData,
  OrderRequest,
  Signal,
} from '../../types';
import { TradeHistory, PricePoint } from '../../data/trade_history';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Default configuration – overridden by config.yaml values
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
const DEFAULTS: ConvergenceConfig = {
  enabled: true,
  min_liquidity_usd: 10_000,
  min_prob: 0.69,
  max_prob: 0.90,
  max_spread_bps: 100,
  max_days_to_resolution: 14,
  spike_pct: 0.08,
  spike_lookback_minutes: 60,
  min_depth_usd_within_1pct: 2_000,
  min_imbalance: 0.10,
  flow_lookback_minutes: 15,
  min_net_buy_flow_usd: 500,
  max_correlated_exposure_pct: 0.25,
  base_risk_pct: 0.005,
  max_position_usd_per_market: 200,
  max_total_open_positions: 10,
  ttl_seconds: 120,
  allow_take_on_momentum: false,
  take_profit_bps: 200,
  stop_loss_bps: 150,
  time_exit_hours: 48,
  max_daily_loss_pct: 0.03,
  max_weekly_drawdown_pct: 0.08,
  max_market_mle_pct: 0.05,
  max_total_mle_pct: 0.15,
  max_orders_per_minute: 10,
  max_cancel_rate: 0.5,
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Internal helpers / tiny types
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Rejection reason when a filter fails */
interface FilterResult {
  pass: boolean;
  reason?: string;
}

/** Composite quality score for a candidate market */
interface SetupScore {
  value: number;          // 0 – 1
  spreadComponent: number;
  depthComponent: number;
  imbalanceComponent: number;
  timeComponent: number;
  volumeComponent: number;
  momentumComponent: number;
}

/** Tracked open position for exit management */
interface ManagedPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  entryPrice: number;
  entryTime: number;
  size: number;
  costBasis: number;
  /** Trailing stop: highest favourable bps seen since entry */
  peakBps: number;
  /** How many partial exits have fired on this position */
  partialExitsTaken: number;
  /** Original entry size before any partial exits */
  originalSize: number;
  /** Setup score at time of entry – used for dynamic exit thresholds */
  setupScore: number;
}

/** Rolling window of recent order timestamps for rate limiting */
interface RateBucket {
  timestamps: number[];
  cancels: number;
}

/** Volume snapshot for volume-trend analysis */
interface VolumeSnapshot {
  volume: number;
  timestamp: number;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Filtered High-Probability Convergence Strategy
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export class FilteredHighProbConvergenceStrategy extends BaseStrategy {
  readonly name = 'filtered_high_prob_convergence';

  /* ── Configuration ── */
  private cfg: ConvergenceConfig = { ...DEFAULTS };

  /* ── Price history cache per market (clobTokenId → points) ── */
  private priceCache = new Map<string, PricePoint[]>();

  /* ── Volume history cache per market (marketId → snapshots) ── */
  private volumeCache = new Map<string, VolumeSnapshot[]>();

  /* ── Positions this strategy manages for exit logic ── */
  private managedPositions: ManagedPosition[] = [];

  /* ── Cluster / correlation exposure tracking (eventId → USD) ── */
  private clusterExposure = new Map<string, number>();

  /* ── Rate-limiting bucket ── */
  private rateBucket: RateBucket = { timestamps: [], cancels: 0 };

  /* ── Daily / weekly drawdown tracking ── */
  private dailyPnl = 0;
  private weeklyPnl = 0;
  private dayStart = 0;
  private weekStart = 0;

  /* ── Shared trade-history client ── */
  private tradeHistory = new TradeHistory();

  /* ── Increase cooldown for this strategy (5 minutes) ── */
  protected override cooldownMs = 300_000;

  /* ── Trailing-stop / partial-exit thresholds (bps) ── */
  private readonly TRAILING_STOP_PULLBACK_BPS = 80;
  private readonly PARTIAL_EXIT_1_BPS = 100;
  private readonly PARTIAL_EXIT_2_BPS = 160;

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Lifecycle
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override initialize(context: StrategyContext): void {
    super.initialize(context);
    // Merge config from YAML over defaults
    const raw = context.config as Partial<ConvergenceConfig>;
    this.cfg = { ...DEFAULTS, ...raw };
    this.dayStart = Date.now();
    this.weekStart = Date.now();
    logger.info(
      { strategy: this.name, cfg: this.cfg },
      'FilteredHighProbConvergence initialised',
    );
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     1. MARKET UPDATE — cache data + maintain price history
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);

    /* Price history for spike / anti-chasing detection */
    const clobId = data.clobTokenIds[0];
    if (clobId) {
      const history = this.priceCache.get(clobId) ?? [];
      history.push({ price: data.midPrice, timestamp: data.timestamp });
      if (history.length > 480) history.shift();
      this.priceCache.set(clobId, history);
    }

    /* Volume history for volume-trend filter */
    const volHistory = this.volumeCache.get(data.marketId) ?? [];
    volHistory.push({ volume: data.volume24h, timestamp: data.timestamp });
    if (volHistory.length > 480) volHistory.shift();
    this.volumeCache.set(data.marketId, volHistory);
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     2. SIGNAL GENERATION — apply all 8 filters
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override generateSignals(): Signal[] {
    if (!this.cfg.enabled) return [];

    /* ── Drawdown guard ── */
    if (this.isDailyLossBreached() || this.isWeeklyDrawdownBreached()) return [];

    const signals: Signal[] = [];
    let evaluated = 0;

    for (const [marketId, market] of this.markets) {
      evaluated++;
      const result = this.evaluateMarket(marketId, market);
      if (result) signals.push(result);
    }

    /* Sort signals by confidence descending – best setups first */
    signals.sort((a, b) => b.confidence - a.confidence);

    if (evaluated > 0) {
      logger.info(
        { strategy: this.name, evaluated, passed: signals.length },
        `Convergence scan: ${signals.length}/${evaluated} markets passed all 8 filters`,
      );
    }

    return signals;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     3. POSITION SIZING — setup-score-based, conservative
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    /* Apply parent cooldown filtering first */
    const cooldownFiltered = super.sizePositions(signals);

    const capital = this.context?.wallet.capitalAllocated ?? 0;
    if (capital <= 0) return [];

    /* ── Enforce max_total_open_positions ── */
    const currentOpen = this.managedPositions.length;
    const slotsAvailable = Math.max(0, this.cfg.max_total_open_positions - currentOpen);
    if (slotsAvailable === 0) return [];

    const sized: OrderRequest[] = [];

    for (const order of cooldownFiltered.slice(0, slotsAvailable)) {
      const market = this.markets.get(order.marketId);
      if (!market) continue;

      /* Rate-limit check */
      if (!this.checkRateLimit()) {
        logger.warn({ strategy: this.name }, 'Order rate limit reached – pausing entries');
        break;
      }

      /* Compute setup score for this candidate */
      const score = this.computeSetupScore(market);

      /* Base size scaled by score (higher score → bigger position) */
      const baseUsd = capital * this.cfg.base_risk_pct;
      let positionUsd = baseUsd * (1 + score.value);  // score adds 0-100% to base
      positionUsd = Math.min(positionUsd, this.cfg.max_position_usd_per_market);
      positionUsd = Math.max(positionUsd, 1); // minimum $1

      /* Kelly-fraction cap: don't bet more than edge / odds implies */
      const kellyFraction = this.computeKellyFraction(market, score);
      const kellyMax = capital * kellyFraction;
      positionUsd = Math.min(positionUsd, kellyMax);

      /* Convert USD to shares at the entry price */
      const entryPrice = this.computeEntryPrice(market, order.side);
      const shares = Math.floor(positionUsd / entryPrice);
      if (shares < 1) continue;

      /* MLE check: max loss at resolution for this market */
      const mle = entryPrice * shares; // max we could lose if resolves to 0
      const mlePct = mle / capital;
      if (mlePct > this.cfg.max_market_mle_pct) continue;

      /* Total MLE across all managed positions */
      const totalMle = this.managedPositions.reduce(
        (sum, p) => sum + p.costBasis,
        0,
      ) + mle;
      if (totalMle / capital > this.cfg.max_total_mle_pct) continue;

      /* Cluster exposure check */
      if (!this.checkClusterExposure(market, positionUsd)) continue;

      sized.push({
        ...order,
        price: Number(entryPrice.toFixed(4)),
        size: shares,
        strategy: this.name,
      });

      this.rateBucket.timestamps.push(Date.now());
    }

    return sized;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     4. POSITION TRACKING — via engine notifyFill callback
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    const market = this.markets.get(order.marketId);
    const score = market ? this.computeSetupScore(market) : { value: 0.5 } as SetupScore;

    this.managedPositions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      entryPrice: order.price,
      entryTime: Date.now(),
      size: order.size,
      costBasis: order.price * order.size,
      peakBps: 0,
      partialExitsTaken: 0,
      originalSize: order.size,
      setupScore: score.value,
    });

    /* Update cluster exposure */
    const clusterId = market?.eventId ?? market?.seriesSlug ?? order.marketId;
    const prev = this.clusterExposure.get(clusterId) ?? 0;
    this.clusterExposure.set(clusterId, prev + order.price * order.size);

    logger.info(
      {
        strategy: this.name,
        marketId: order.marketId,
        outcome: order.outcome,
        price: order.price,
        size: order.size,
        costBasis: (order.price * order.size).toFixed(2),
        setupScore: score.value,
      },
      `CONVERGENCE entry: ${order.outcome} at $${order.price.toFixed(4)} × ${order.size} (score=${score.value.toFixed(3)})`,
    );
  }

  /** Legacy — position tracking now handled by notifyFill */
  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     5. POSITION MANAGEMENT — trailing TP / partial exits / SL / TIME
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  override managePositions(): void {
    this.resetDrawdownCounters();
    const now = Date.now();
    const toClose: ManagedPosition[] = [];
    const partialSells: { pos: ManagedPosition; sellShares: number; reason: string }[] = [];

    for (const pos of this.managedPositions) {
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentMid = market.midPrice;
      const entryBps = ((currentMid - pos.entryPrice) / pos.entryPrice) * 10_000;
      const hoursHeld = (now - pos.entryTime) / 3_600_000;

      /* ── Update trailing peak ── */
      if (entryBps > pos.peakBps) {
        pos.peakBps = entryBps;
      }

      let exitReason: string | undefined;

      /* ── Partial Exit 1: take 1/3 at +100 bps ── */
      if (pos.partialExitsTaken === 0 && entryBps >= this.PARTIAL_EXIT_1_BPS && pos.size > 2) {
        const sellShares = Math.max(1, Math.floor(pos.originalSize / 3));
        partialSells.push({ pos, sellShares, reason: `PARTIAL_1 (+${entryBps.toFixed(0)} bps)` });
        pos.partialExitsTaken = 1;
        continue; // don't evaluate further exits this tick
      }

      /* ── Partial Exit 2: take another 1/3 at +160 bps ── */
      if (pos.partialExitsTaken === 1 && entryBps >= this.PARTIAL_EXIT_2_BPS && pos.size > 1) {
        const sellShares = Math.max(1, Math.floor(pos.originalSize / 3));
        partialSells.push({ pos, sellShares, reason: `PARTIAL_2 (+${entryBps.toFixed(0)} bps)` });
        pos.partialExitsTaken = 2;
        continue;
      }

      /* ── Trailing Take Profit: once past TP level, trail from peak ── */
      if (pos.peakBps >= this.cfg.take_profit_bps) {
        const pullback = pos.peakBps - entryBps;
        if (pullback >= this.TRAILING_STOP_PULLBACK_BPS) {
          exitReason = `TRAILING_TP (peak +${pos.peakBps.toFixed(0)} bps, pullback -${pullback.toFixed(0)} bps)`;
        }
      }

      /* ── Hard Take Profit: exit remaining at 3× TP (prevent round-tripping) ── */
      if (!exitReason && entryBps >= this.cfg.take_profit_bps * 3) {
        exitReason = `HARD_TP (+${entryBps.toFixed(0)} bps)`;
      }

      /* ── Stop Loss ── */
      if (!exitReason && entryBps <= -this.cfg.stop_loss_bps) {
        exitReason = `STOP_LOSS (${entryBps.toFixed(0)} bps)`;
      }

      /* ── Dynamic Time Exit: adjusted by setup quality ── */
      if (!exitReason) {
        const timeMultiplier = 0.5 + pos.setupScore; // 0.55 – 1.5×
        const dynamicTimeHours = this.cfg.time_exit_hours * timeMultiplier;
        if (hoursHeld >= dynamicTimeHours) {
          exitReason = `TIME_EXIT (${hoursHeld.toFixed(1)}h / max ${dynamicTimeHours.toFixed(1)}h)`;
        }
      }

      /* ── Spread widening near resolution ── */
      if (!exitReason && market.endDate) {
        const daysLeft = (new Date(market.endDate).getTime() - now) / 86_400_000;
        const spreadBps = (market.spread / market.midPrice) * 10_000;
        if (daysLeft < 1 && spreadBps > this.cfg.max_spread_bps * 2) {
          exitReason = `NEAR_RESOLUTION_SPREAD_WIDEN (${daysLeft.toFixed(1)}d left, ${spreadBps.toFixed(0)} bps spread)`;
        }
      }

      /* ── Adverse momentum exit: price reversing strongly against us ── */
      if (!exitReason && entryBps < 0) {
        const clobId = market.clobTokenIds[0];
        if (clobId) {
          const hist = this.priceCache.get(clobId) ?? [];
          if (hist.length >= 10) {
            const recent5 = hist.slice(-5);
            const recentMomentum = (recent5[recent5.length - 1].price - recent5[0].price) / Math.max(0.001, recent5[0].price);
            if (recentMomentum < -0.02 && entryBps < -50) {
              exitReason = `ADVERSE_MOMENTUM (bps=${entryBps.toFixed(0)}, move=${(recentMomentum * 100).toFixed(1)}%)`;
            }
          }
        }
      }

      if (exitReason) {
        toClose.push(pos);
        const pnl = (currentMid - pos.entryPrice) * pos.size;
        this.dailyPnl += pnl;
        this.weeklyPnl += pnl;

        /* Queue a SELL order so the wallet records the realized PnL */
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: 'SELL',
          price: currentMid,
          size: pos.size,
          strategy: this.name,
        });

        /* Update cluster exposure */
        const clusterId = market.eventId ?? market.seriesSlug ?? pos.marketId;
        const prev = this.clusterExposure.get(clusterId) ?? 0;
        this.clusterExposure.set(clusterId, Math.max(0, prev - pos.costBasis));

        logger.info(
          {
            strategy: this.name,
            marketId: pos.marketId,
            outcome: pos.outcome,
            reason: exitReason,
            pnl: pnl.toFixed(4),
            hoursHeld: hoursHeld.toFixed(1),
            peakBps: pos.peakBps.toFixed(0),
          },
          `CONVERGENCE exit: ${pos.outcome} market=${pos.marketId} reason=${exitReason} pnl=$${pnl.toFixed(4)}`,
        );
      }
    }

    /* Execute partial exits (reduce size but keep position open) */
    for (const { pos, sellShares, reason } of partialSells) {
      const actualSell = Math.min(sellShares, pos.size - 1);
      if (actualSell < 1) continue;
      const market = this.markets.get(pos.marketId);
      const sellPrice = market?.midPrice ?? pos.entryPrice;
      const pnl = (sellPrice - pos.entryPrice) * actualSell;
      pos.size -= actualSell;
      pos.costBasis = pos.entryPrice * pos.size;
      this.dailyPnl += pnl;
      this.weeklyPnl += pnl;

      /* Queue a partial SELL order through the wallet */
      this.pendingExits.push({
        walletId: this.context?.wallet.walletId ?? 'unknown',
        marketId: pos.marketId,
        outcome: pos.outcome,
        side: 'SELL',
        price: sellPrice,
        size: actualSell,
        strategy: this.name,
      });

      logger.info(
        {
          strategy: this.name,
          marketId: pos.marketId,
          reason,
          sharesSold: actualSell,
          remainingSize: pos.size,
          pnl: pnl.toFixed(4),
        },
        `CONVERGENCE partial exit: ${reason} sold ${actualSell} shares, ${pos.size} remaining`,
      );
    }

    /* Remove fully closed positions */
    for (const closed of toClose) {
      const idx = this.managedPositions.indexOf(closed);
      if (idx >= 0) this.managedPositions.splice(idx, 1);
    }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     FILTER PIPELINE — 8 filters
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  private evaluateMarket(marketId: string, m: MarketData): Signal | null {
    const filterNames = [
      'liquidity', 'probBand', 'spread', 'timeToRes',
      'antiChase', 'flow', 'volumeTrend', 'cluster',
    ] as const;
    const filters: FilterResult[] = [
      this.filterLiquidity(m),
      this.filterProbabilityBand(m),
      this.filterSpread(m),
      this.filterTimeToResolution(m),
      this.filterAntiChasing(m),
      this.filterFlowPressure(m),
      this.filterVolumeTrend(m),
      this.filterClusterExposure(m),
    ];

    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (!f.pass) {
        logger.debug(
          { strategy: this.name, marketId, filter: filterNames[i], reason: f.reason },
          `Filter ${filterNames[i]} rejected market`,
        );
        return null;
      }
    }

    /* All filters passed → decide direction */
    const impliedProb = m.midPrice;
    const outcome = impliedProb >= 0.5 ? 'YES' as const : 'NO' as const;
    const score = this.computeSetupScore(m);

    /* Higher-quality edge calculation incorporating the full score */
    const rawEdge = Math.abs(impliedProb - 0.5);
    const adjustedEdge = rawEdge * (0.5 + score.value * 0.5);

    return {
      marketId,
      outcome,
      side: 'BUY',
      confidence: score.value,
      edge: adjustedEdge,
    };
  }

  /* ─── A) Liquidity Filter ─── */
  private filterLiquidity(m: MarketData): FilterResult {
    if (m.liquidity < this.cfg.min_liquidity_usd) {
      return { pass: false, reason: `liquidity $${m.liquidity.toFixed(0)} < min $${this.cfg.min_liquidity_usd}` };
    }
    // Approximate depth within 1% of mid using liquidity and spread
    // Depth ≈ liquidity * (1% / half-spread) as a rough heuristic
    const halfSpread = Math.max(0.0001, m.spread / 2);
    const depthEstimate = m.liquidity * (0.01 / halfSpread);
    if (depthEstimate < this.cfg.min_depth_usd_within_1pct) {
      return { pass: false, reason: `est depth $${depthEstimate.toFixed(0)} < min $${this.cfg.min_depth_usd_within_1pct}` };
    }
    return { pass: true };
  }

  /* ─── B) Probability Band Filter ─── */
  private filterProbabilityBand(m: MarketData): FilterResult {
    const impliedProb = m.midPrice;
    // For a YES-dominant market, midPrice IS the implied prob of YES.
    // For NO-dominant, we consider 1 - midPrice for the NO side.
    // We want the *leading* outcome's probability to be in [min_prob, max_prob].
    const leadingProb = Math.max(impliedProb, 1 - impliedProb);
    if (leadingProb < this.cfg.min_prob) {
      return { pass: false, reason: `leading prob ${(leadingProb * 100).toFixed(1)}% < min ${this.cfg.min_prob * 100}%` };
    }
    if (leadingProb > this.cfg.max_prob) {
      return { pass: false, reason: `leading prob ${(leadingProb * 100).toFixed(1)}% > max ${this.cfg.max_prob * 100}%` };
    }
    return { pass: true };
  }

  /* ─── C) Spread Filter ─── */
  private filterSpread(m: MarketData): FilterResult {
    const spreadBps = (m.spread / Math.max(0.001, m.midPrice)) * 10_000;
    if (spreadBps > this.cfg.max_spread_bps) {
      return { pass: false, reason: `spread ${spreadBps.toFixed(0)} bps > max ${this.cfg.max_spread_bps} bps` };
    }
    return { pass: true };
  }

  /* ─── D) Time-to-Resolution Filter ─── */
  private filterTimeToResolution(m: MarketData): FilterResult {
    if (!m.endDate) {
      return { pass: false, reason: 'no endDate – skipping unknown horizon' };
    }
    const daysLeft = (new Date(m.endDate).getTime() - Date.now()) / 86_400_000;
    if (daysLeft <= 0) {
      return { pass: false, reason: 'market already past endDate' };
    }
    if (daysLeft > this.cfg.max_days_to_resolution) {
      return { pass: false, reason: `${daysLeft.toFixed(1)} days > max ${this.cfg.max_days_to_resolution}` };
    }
    return { pass: true };
  }

  /* ─── E) Anti-Chasing (spike / volatility) Filter ─── */
  private filterAntiChasing(m: MarketData): FilterResult {
    const clobId = m.clobTokenIds[0];
    if (!clobId) return { pass: true }; // can't check, allow

    const history = this.priceCache.get(clobId) ?? [];
    if (history.length < 4) return { pass: true }; // not enough data yet

    const lookbackMs = this.cfg.spike_lookback_minutes * 60_000;
    const cutoff = Date.now() - lookbackMs;
    const recent = history.filter((p) => p.timestamp >= cutoff);
    if (recent.length < 2) return { pass: true };

    const oldest = recent[0].price;
    const newest = recent[recent.length - 1].price;
    const change = Math.abs(newest - oldest) / Math.max(0.001, oldest);

    if (change >= this.cfg.spike_pct) {
      return { pass: false, reason: `recent spike ${(change * 100).toFixed(1)}% >= ${this.cfg.spike_pct * 100}%` };
    }

    /* Realised volatility check: stdev of returns */
    if (recent.length >= 5) {
      const returns: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        returns.push((recent[i].price - recent[i - 1].price) / Math.max(0.001, recent[i - 1].price));
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
      const vol = Math.sqrt(variance);
      // Reject if annualised vol proxy > 3× spike threshold
      if (vol > this.cfg.spike_pct * 0.5) {
        return { pass: false, reason: `high vol ${(vol * 100).toFixed(2)}%` };
      }
    }

    return { pass: true };
  }

  /* ─── F) Flow / Pressure Confirmation (rule-based) ─── */
  private filterFlowPressure(m: MarketData): FilterResult {
    /* Orderbook imbalance from bid / ask levels */
    const bidSize = m.bid * m.liquidity;   // approximate bid-side depth
    const askSize = (1 - m.ask) * m.liquidity; // approximate ask-side depth
    const total = bidSize + askSize;
    const imbalance = total > 0 ? (bidSize - askSize) / total : 0;

    const imbalanceOk = imbalance >= this.cfg.min_imbalance;

    /* Net buy flow proxy: if price has been trending up over the flow window,
       approximate net buy flow from price × volume. */
    const clobId = m.clobTokenIds[0];
    let flowOk = false;
    if (clobId) {
      const history = this.priceCache.get(clobId) ?? [];
      const cutoff = Date.now() - this.cfg.flow_lookback_minutes * 60_000;
      const recent = history.filter((p) => p.timestamp >= cutoff);
      if (recent.length >= 2) {
        const priceMove = recent[recent.length - 1].price - recent[0].price;
        // Rough net flow estimate: price move × volume / # samples
        const netFlowEstimate = priceMove * m.volume24h / Math.max(1, recent.length);
        flowOk = netFlowEstimate >= this.cfg.min_net_buy_flow_usd;
      }
    }

    if (!imbalanceOk && !flowOk) {
      return { pass: false, reason: `imbalance ${(imbalance * 100).toFixed(1)}% < ${this.cfg.min_imbalance * 100}% AND no flow confirmation` };
    }
    return { pass: true };
  }

  /* ─── G) Volume Trend Filter (8th filter) ─── */
  private filterVolumeTrend(m: MarketData): FilterResult {
    const volHistory = this.volumeCache.get(m.marketId) ?? [];
    if (volHistory.length < 4) return { pass: true }; // not enough data

    const quarter = Math.floor(volHistory.length / 4);
    const earlySlice = volHistory.slice(0, quarter);
    const lateSlice = volHistory.slice(-quarter);

    const earlyAvg = earlySlice.reduce((s, v) => s + v.volume, 0) / earlySlice.length;
    const lateAvg = lateSlice.reduce((s, v) => s + v.volume, 0) / lateSlice.length;

    if (earlyAvg > 0 && (lateAvg / earlyAvg) < 0.70) {
      return {
        pass: false,
        reason: `volume declining: recent $${lateAvg.toFixed(0)} vs earlier $${earlyAvg.toFixed(0)} (${((lateAvg / earlyAvg) * 100).toFixed(0)}%)`,
      };
    }
    return { pass: true };
  }

  /* ─── H) Correlation / Cluster Exposure Filter ─── */
  private filterClusterExposure(m: MarketData): FilterResult {
    const clusterId = m.eventId ?? m.seriesSlug ?? m.marketId;
    const currentExposure = this.clusterExposure.get(clusterId) ?? 0;
    const capital = this.context?.wallet.capitalAllocated ?? 1;
    const exposurePct = currentExposure / capital;

    if (exposurePct >= this.cfg.max_correlated_exposure_pct) {
      return { pass: false, reason: `cluster "${clusterId}" exposure ${(exposurePct * 100).toFixed(1)}% >= max ${this.cfg.max_correlated_exposure_pct * 100}%` };
    }
    return { pass: true };
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     SETUP SCORE — 7-factor weighted composite [0, 1]
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  private computeSetupScore(m: MarketData): SetupScore {
    /* 1. Spread: tighter → higher */
    const spreadBps = (m.spread / Math.max(0.001, m.midPrice)) * 10_000;
    const spreadComponent = Math.max(0, Math.min(1, 1 - spreadBps / this.cfg.max_spread_bps));

    /* 2. Depth: more depth → higher */
    const halfSpread = Math.max(0.0001, m.spread / 2);
    const depthEstimate = m.liquidity * (0.01 / halfSpread);
    const depthComponent = Math.max(0, Math.min(1, depthEstimate / (this.cfg.min_depth_usd_within_1pct * 5)));

    /* 3. Imbalance / flow */
    const bidSize = m.bid * m.liquidity;
    const askSize = (1 - m.ask) * m.liquidity;
    const total = bidSize + askSize;
    const imbalance = total > 0 ? (bidSize - askSize) / total : 0;
    const imbalanceComponent = Math.max(0, Math.min(1, imbalance / 0.5));

    /* 4. Time: shorter horizon → higher */
    let timeComponent = 0.5;
    if (m.endDate) {
      const daysLeft = Math.max(0.1, (new Date(m.endDate).getTime() - Date.now()) / 86_400_000);
      timeComponent = Math.max(0, Math.min(1, 1 - daysLeft / this.cfg.max_days_to_resolution));
    }

    /* 5. Volume: higher relative volume → higher score */
    let volumeComponent = 0.5;
    const volHistory = this.volumeCache.get(m.marketId) ?? [];
    if (volHistory.length >= 4) {
      const avgVol = volHistory.reduce((s, v) => s + v.volume, 0) / volHistory.length;
      const volRatio = avgVol > 0 ? m.volume24h / avgVol : 1;
      volumeComponent = Math.max(0, Math.min(1, (volRatio - 0.5) / 1.5));
    }

    /* 6. Momentum: gentle positive drift is ideal for convergence */
    let momentumComponent = 0.5;
    const clobId = m.clobTokenIds[0];
    if (clobId) {
      const hist = this.priceCache.get(clobId) ?? [];
      if (hist.length >= 5) {
        const recent = hist.slice(-10);
        const drift = (recent[recent.length - 1].price - recent[0].price) / Math.max(0.001, recent[0].price);
        if (drift >= 0 && drift <= 0.04) {
          momentumComponent = 0.5 + drift * 12.5; // 0.5–1.0 for 0–4% drift
        } else if (drift > 0.04) {
          momentumComponent = 0.3; // too much momentum, might be chasing
        } else {
          momentumComponent = Math.max(0, 0.5 + drift * 10);
        }
      }
    }

    /* Weighted: spread 20%, depth 15%, flow 20%, time 15%, volume 15%, momentum 15% */
    const value = 0.20 * spreadComponent
               + 0.15 * depthComponent
               + 0.20 * imbalanceComponent
               + 0.15 * timeComponent
               + 0.15 * volumeComponent
               + 0.15 * momentumComponent;

    return {
      value: Number(Math.max(0.05, Math.min(1, value)).toFixed(4)),
      spreadComponent: Number(spreadComponent.toFixed(4)),
      depthComponent: Number(depthComponent.toFixed(4)),
      imbalanceComponent: Number(imbalanceComponent.toFixed(4)),
      timeComponent: Number(timeComponent.toFixed(4)),
      volumeComponent: Number(volumeComponent.toFixed(4)),
      momentumComponent: Number(momentumComponent.toFixed(4)),
    };
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     KELLY FRACTION — conservative half-Kelly sizing cap
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  private computeKellyFraction(_m: MarketData, score: SetupScore): number {
    const impliedProb = Math.max(_m.midPrice, 1 - _m.midPrice);
    const winProb = Math.min(0.95, impliedProb + score.value * 0.05);
    const entryPrice = _m.bid + 0.001;
    const b = (1 - entryPrice) / Math.max(0.01, entryPrice);
    const kelly = Math.max(0, (b * winProb - (1 - winProb)) / b);
    return Math.min(0.05, kelly * 0.5); // half-Kelly, cap at 5% of capital
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ENTRY PRICE — VWAP-aware passive limit
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  private computeEntryPrice(m: MarketData, side: 'BUY' | 'SELL'): number {
    /* Compute recent VWAP as an anchor */
    const clobId = m.clobTokenIds[0];
    let vwap = m.midPrice;
    if (clobId) {
      const hist = this.priceCache.get(clobId) ?? [];
      if (hist.length >= 5) {
        const recent = hist.slice(-20);
        vwap = recent.reduce((s, p) => s + p.price, 0) / recent.length;
      }
    }

    if (side === 'BUY') {
      const passivePrice = m.bid + 0.001;
      const vwapCap = vwap + m.spread * 0.2; // don't overpay relative to VWAP
      let price = Math.min(passivePrice, vwapCap);
      if (this.cfg.allow_take_on_momentum) {
        price = Math.min(m.ask, price + m.spread * 0.3);
      }
      return Math.max(0.01, Math.min(m.ask - 0.001, price));
    }
    // SELL side
    const passivePrice = m.ask - 0.001;
    return Math.max(m.bid + 0.001, passivePrice);
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     RISK HELPERS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  /** Check and enforce the per-cluster (event/series) exposure cap */
  private checkClusterExposure(m: MarketData, addUsd: number): boolean {
    const clusterId = m.eventId ?? m.seriesSlug ?? m.marketId;
    const current = this.clusterExposure.get(clusterId) ?? 0;
    const capital = this.context?.wallet.capitalAllocated ?? 1;
    return (current + addUsd) / capital <= this.cfg.max_correlated_exposure_pct;
  }

  /** Per-minute rate limit */
  private checkRateLimit(): boolean {
    const now = Date.now();
    this.rateBucket.timestamps = this.rateBucket.timestamps.filter(
      (t) => now - t < 60_000,
    );
    return this.rateBucket.timestamps.length < this.cfg.max_orders_per_minute;
  }

  /** Daily loss guard */
  private isDailyLossBreached(): boolean {
    const capital = this.context?.wallet.capitalAllocated ?? 1;
    return this.dailyPnl / capital <= -this.cfg.max_daily_loss_pct;
  }

  /** Weekly drawdown guard */
  private isWeeklyDrawdownBreached(): boolean {
    const capital = this.context?.wallet.capitalAllocated ?? 1;
    return this.weeklyPnl / capital <= -this.cfg.max_weekly_drawdown_pct;
  }

  /** Reset daily/weekly PnL counters on calendar rollover */
  private resetDrawdownCounters(): void {
    const now = Date.now();
    // Reset daily counter every 24 hours
    if (now - this.dayStart > 86_400_000) {
      this.dailyPnl = 0;
      this.dayStart = now;
    }
    // Reset weekly counter every 7 days
    if (now - this.weekStart > 7 * 86_400_000) {
      this.weeklyPnl = 0;
      this.weekStart = now;
    }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     DIAGNOSTICS — expose for dashboard / debugging
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  /** Get all currently managed positions (for dashboard) */
  getManagedPositions(): readonly ManagedPosition[] {
    return this.managedPositions;
  }

  /** Get cluster exposure map (for dashboard) */
  getClusterExposure(): ReadonlyMap<string, number> {
    return this.clusterExposure;
  }

  /** Get drawdown stats */
  getDrawdownStats(): { dailyPnl: number; weeklyPnl: number } {
    return { dailyPnl: this.dailyPnl, weeklyPnl: this.weeklyPnl };
  }
}
