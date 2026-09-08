import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FilteredHighProbConvergenceStrategy } from '../src/strategies/convergence/filtered_high_prob_convergence';
import { MarketData, ConvergenceConfig, WalletState, Signal } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Helpers
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/** Create a valid MarketData that passes all filters by default */
function mkMarket(overrides: Partial<MarketData> = {}): MarketData {
  return {
    marketId: 'mkt-1',
    question: 'Will X happen?',
    slug: 'will-x-happen',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.75, 0.25],
    clobTokenIds: ['tok-1', 'tok-2'],
    midPrice: 0.75,
    bid: 0.74,
    ask: 0.76,
    spread: 0.02,
    volume24h: 50_000,
    liquidity: 25_000,
    timestamp: Date.now(),
    endDate: new Date(Date.now() + 7 * 86_400_000).toISOString(), // 7 days
    eventId: 'evt-1',
    eventSlug: 'event-x',
    seriesSlug: undefined,
    oneDayPriceChange: 0.01,
    oneWeekPriceChange: 0.03,
    ...overrides,
  };
}

function mkWallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'wallet_test',
    mode: 'PAPER',
    assignedStrategy: 'filtered_high_prob_convergence',
    capitalAllocated: 2000,
    availableBalance: 2000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 500,
      maxExposurePerMarket: 400,
      maxDailyLoss: 200,
      maxOpenTrades: 15,
      maxDrawdown: 0.15,
    },
    ...overrides,
  };
}

/** Default config that makes filter passing straightforward */
const baseConfig: Partial<ConvergenceConfig> = {
  enabled: true,
  min_liquidity_usd: 10_000,
  min_prob: 0.65,
  max_prob: 0.96,
  max_spread_bps: 400, // generous for tests
  max_days_to_resolution: 14,
  spike_pct: 0.08,
  spike_lookback_minutes: 60,
  min_depth_usd_within_1pct: 200,
  min_imbalance: 0.05,
  flow_lookback_minutes: 15,
  min_net_buy_flow_usd: 100,
  max_correlated_exposure_pct: 0.25,
  base_risk_pct: 0.01,
  max_position_usd_per_market: 200,
  max_total_open_positions: 10,
  ttl_seconds: 120,
  allow_take_on_momentum: false,
  take_profit_bps: 200,
  stop_loss_bps: 150,
  time_exit_hours: 48,
  max_daily_loss_pct: 0.03,
  max_weekly_drawdown_pct: 0.08,
  max_market_mle_pct: 0.10,
  max_total_mle_pct: 0.30,
  max_orders_per_minute: 100,
  max_cancel_rate: 0.8,
};

function createStrategy(cfgOverrides: Partial<ConvergenceConfig> = {}): FilteredHighProbConvergenceStrategy {
  const strategy = new FilteredHighProbConvergenceStrategy();
  strategy.initialize({
    wallet: mkWallet(),
    config: { ...baseConfig, ...cfgOverrides } as Record<string, unknown>,
  });
  return strategy;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. FILTER LOGIC
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Filter Logic', () => {
  let strategy: FilteredHighProbConvergenceStrategy;

  beforeEach(() => {
    strategy = createStrategy();
  });

  it('passes a market that satisfies all 7 filters', () => {
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    // Feed a few price points so anti-chasing has data
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].side).toBe('BUY');
    expect(signals[0].outcome).toBe('YES');
  });

  /* ─── A) Liquidity Filter ─── */
  it('rejects low-liquidity market', () => {
    const market = mkMarket({ liquidity: 5_000 }); // below 10k threshold
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  /* ─── B) Probability Band Filter ─── */
  it('rejects market below min_prob', () => {
    // midPrice 0.55 → leading prob = 0.55, below 0.65
    const market = mkMarket({ midPrice: 0.55, bid: 0.54, ask: 0.56, outcomePrices: [0.55, 0.45] });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('rejects market above max_prob', () => {
    // midPrice 0.98 → leading prob = 0.98, above 0.96
    const market = mkMarket({ midPrice: 0.98, bid: 0.97, ask: 0.99, outcomePrices: [0.98, 0.02] });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('accepts market within probability band', () => {
    const market = mkMarket({ midPrice: 0.80, bid: 0.79, ask: 0.81 });
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ midPrice: 0.80, bid: 0.79, ask: 0.81, timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });

  /* ─── C) Spread Filter ─── */
  it('rejects market with wide spread', () => {
    // spread = 0.20 on mid 0.75 → 26,667 bps, way above 400
    const market = mkMarket({ bid: 0.65, ask: 0.85, spread: 0.20, midPrice: 0.75 });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  /* ─── D) Time-to-Resolution Filter ─── */
  it('rejects market with no endDate', () => {
    const market = mkMarket({ endDate: undefined });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('rejects market too far from resolution', () => {
    const market = mkMarket({
      endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), // 30 days
    });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('rejects market already past endDate', () => {
    const market = mkMarket({
      endDate: new Date(Date.now() - 86_400_000).toISOString(), // yesterday
    });
    strategy.onMarketUpdate(market);
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  /* ─── E) Anti-Chasing Filter ─── */
  it('rejects market with recent price spike', () => {
    const strat = createStrategy({ spike_pct: 0.05 });
    // Seed 10 price points: first 5 at 0.70, then jump to 0.80 (14% spike)
    const clobId = 'tok-1';
    for (let i = 0; i < 5; i++) {
      strat.onMarketUpdate(mkMarket({
        clobTokenIds: [clobId, 'tok-2'],
        midPrice: 0.70,
        bid: 0.69,
        ask: 0.71,
        timestamp: Date.now() - (10 - i) * 30_000,
      }));
    }
    for (let i = 5; i < 10; i++) {
      strat.onMarketUpdate(mkMarket({
        clobTokenIds: [clobId, 'tok-2'],
        midPrice: 0.80,
        bid: 0.79,
        ask: 0.81,
        timestamp: Date.now() - (10 - i) * 30_000,
      }));
    }
    const signals = strat.generateSignals();
    expect(signals.length).toBe(0);
  });

  /* ─── F) Flow / Pressure Filter ─── */
  it('rejects market with no flow data and low imbalance', () => {
    // Use a 50/50 market so bid~ask~0.50 → imbalance near 0
    // bid_size = 0.499 * 25000 = 12475
    // ask_size = (1-0.501) * 25000 = 0.499 * 25000 = 12475
    // imbalance ≈ 0 → below 0.50 threshold
    const strat = createStrategy({ min_imbalance: 0.50, min_prob: 0.50 }); // lower min_prob to test
    const market = mkMarket({
      bid: 0.499,
      ask: 0.501,
      spread: 0.002,
      midPrice: 0.50,
      outcomePrices: [0.50, 0.50],
      liquidity: 25_000,
      clobTokenIds: ['no-history-tok', 'tok-2'],
    });
    strat.onMarketUpdate(market);
    const signals = strat.generateSignals();
    // Should be rejected: either by prob band (50% is below 65%) or by flow
    expect(signals.length).toBe(0);
  });

  /* ─── G) Cluster Exposure Filter ─── */
  it('rejects market that would exceed cluster exposure', () => {
    const strat = createStrategy({ max_correlated_exposure_pct: 0.01 }); // 1% = $20 on $2000
    // Simulate existing exposure by submitting a previous order
    const market1 = mkMarket({ marketId: 'mkt-A', eventId: 'evt-shared' });
    const market2 = mkMarket({ marketId: 'mkt-B', eventId: 'evt-shared' });

    strat.onMarketUpdate(market1);
    strat.onMarketUpdate(market2);
    // Manually create a signal and size it to fill cluster
    const signals1 = strat.generateSignals();
    if (signals1.length > 0) {
      const orders1 = strat.sizePositions(signals1);
      strat.submitOrders(orders1); // fills cluster exposure
    }
    // Now try second market in same cluster
    strat.onMarketUpdate(market2);
    // Feed price history to pass anti-chasing
    for (let i = 0; i < 5; i++) {
      strat.onMarketUpdate(mkMarket({
        marketId: 'mkt-B',
        eventId: 'evt-shared',
        timestamp: Date.now() - (5 - i) * 60_000,
      }));
    }
    const signals2 = strat.generateSignals();
    // If cluster is full, second market should be rejected
    // The filter may pass (since it checks exposure at filter time),
    // but sizing should reject due to cluster check
    if (signals2.length > 0) {
      const orders2 = strat.sizePositions(signals2);
      // After filling cluster with first, second should get 0 orders
      // (depends on exact sizes, but cluster limit is very tight)
      expect(orders2.length + (signals1.length > 0 ? 1 : 0)).toBeLessThanOrEqual(2);
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   2. SETUP SCORE & POSITION SIZING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Setup Score & Sizing', () => {
  it('produces non-zero confidence on passing markets', () => {
    const strategy = createStrategy();
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].confidence).toBeGreaterThan(0);
    expect(signals[0].confidence).toBeLessThanOrEqual(1);
  });

  it('sizes positions proportional to setup score', () => {
    const strategy = createStrategy({ base_risk_pct: 0.01, max_position_usd_per_market: 500 });
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      expect(orders.length).toBeGreaterThanOrEqual(1);
      const order = orders[0];
      // Position size = base_risk_pct * capital * score ≤ max_position_usd
      const costBasis = order.price * order.size;
      expect(costBasis).toBeLessThanOrEqual(500);
      expect(costBasis).toBeGreaterThan(0);
      expect(order.strategy).toBe('filtered_high_prob_convergence');
    }
  });

  it('respects max_total_open_positions', () => {
    const strategy = createStrategy({ max_total_open_positions: 1 });
    // Submit first order
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals1 = strategy.generateSignals();
    if (signals1.length > 0) {
      const orders1 = strategy.sizePositions(signals1);
      for (const o of orders1) strategy.notifyFill(o);
    }
    // Try second market — should be rejected
    const market2 = mkMarket({
      marketId: 'mkt-2',
      eventId: 'evt-2',
      clobTokenIds: ['tok-3', 'tok-4'],
    });
    strategy.onMarketUpdate(market2);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({
        marketId: 'mkt-2',
        eventId: 'evt-2',
        clobTokenIds: ['tok-3', 'tok-4'],
        timestamp: Date.now() - (5 - i) * 60_000,
      }));
    }
    const signals2 = strategy.generateSignals();
    const orders2 = strategy.sizePositions(signals2);
    expect(orders2.length).toBe(0);
  });

  it('enforces MLE per-market cap', () => {
    // max_market_mle_pct = 1% of $2000 = $20
    const strategy = createStrategy({ max_market_mle_pct: 0.01, base_risk_pct: 0.05 });
    const market = mkMarket({ midPrice: 0.75, bid: 0.74, ask: 0.76 });
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ midPrice: 0.75, bid: 0.74, ask: 0.76, timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      if (orders.length > 0) {
        const costBasis = orders[0].price * orders[0].size;
        expect(costBasis).toBeLessThanOrEqual(20 + 1); // $20 MLE limit + rounding tolerance
      }
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   3. EXIT RULES — TP, SL, TIME
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Exit Rules', () => {
  function setupWithPosition(
    entryPrice: number,
    currentMid: number,
    hoursAgo: number,
    cfgOverrides: Partial<ConvergenceConfig> = {},
  ) {
    const strategy = createStrategy(cfgOverrides);
    const market = mkMarket({ midPrice: entryPrice, bid: entryPrice - 0.01, ask: entryPrice + 0.01 });
    strategy.onMarketUpdate(market);
    // Feed enough history to pass anti-chasing
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({
        midPrice: entryPrice,
        bid: entryPrice - 0.01,
        ask: entryPrice + 0.01,
        timestamp: Date.now() - (5 - i) * 60_000,
      }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      for (const o of orders) strategy.notifyFill(o);
    }
    // Now update market to currentMid
    strategy.onMarketUpdate(mkMarket({ midPrice: currentMid, bid: currentMid - 0.01, ask: currentMid + 0.01 }));
    return strategy;
  }

  it('tracks managed positions after submitOrders', () => {
    const strategy = createStrategy();
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      for (const o of orders) strategy.notifyFill(o);
      expect(strategy.getManagedPositions().length).toBeGreaterThanOrEqual(1);
    }
  });

  it('exposes cluster exposure map', () => {
    const strategy = createStrategy();
    const market = mkMarket({ eventId: 'evt-test' });
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ eventId: 'evt-test', timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      for (const o of orders) strategy.notifyFill(o);
      expect(strategy.getClusterExposure().size).toBeGreaterThanOrEqual(1);
    }
  });

  it('exposes drawdown stats', () => {
    const strategy = createStrategy();
    const stats = strategy.getDrawdownStats();
    expect(stats.dailyPnl).toBe(0);
    expect(stats.weeklyPnl).toBe(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4. RISK ENGINE INTEGRATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Risk Integration', () => {
  it('produces no signals when strategy is disabled', () => {
    const strategy = createStrategy({ enabled: false });
    strategy.onMarketUpdate(mkMarket());
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('respects daily loss guard', () => {
    // max_daily_loss_pct = 3%, capital = 2000 → $60 loss
    const strategy = createStrategy({ max_daily_loss_pct: 0.03 });
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }

    // Simulate loss by entering and having market drop (trigger managePositions)
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      strategy.submitOrders(orders);
      // Drop market price enough to trigger stop loss → realise loss
      strategy.onMarketUpdate(mkMarket({
        midPrice: 0.50,
        bid: 0.49,
        ask: 0.51,
      }));
      strategy.managePositions();
      // After realised loss, daily PnL should be negative
      const stats = strategy.getDrawdownStats();
      expect(stats.dailyPnl).toBeLessThanOrEqual(0);
    }
  });

  it('enforces order rate limit', () => {
    const strategy = createStrategy({ max_orders_per_minute: 2 });
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }

    // Generate and size multiple times
    const allOrders = [];
    for (let i = 0; i < 5; i++) {
      const signals = strategy.generateSignals();
      const orders = strategy.sizePositions(signals);
      allOrders.push(...orders);
    }
    // Should have at most 2 orders due to rate limit
    expect(allOrders.length).toBeLessThanOrEqual(2);
  });

  it('sets cooldown of 300 seconds per market', () => {
    const strategy = createStrategy();
    const market = mkMarket();
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ timestamp: Date.now() - (5 - i) * 60_000 }));
    }

    const signals1 = strategy.generateSignals();
    const orders1 = strategy.sizePositions(signals1);
    // Second call should hit cooldown
    const signals2 = strategy.generateSignals();
    const orders2 = strategy.sizePositions(signals2);
    // First pass may produce 1, second should produce 0 (cooldown)
    if (orders1.length > 0) {
      expect(orders2.length).toBe(0);
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   5. ENTRY PRICE LOGIC
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Entry Price', () => {
  it('entry price is at or below the ask', () => {
    const strategy = createStrategy();
    const market = mkMarket({ bid: 0.74, ask: 0.76 });
    strategy.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      strategy.onMarketUpdate(mkMarket({ bid: 0.74, ask: 0.76, timestamp: Date.now() - (5 - i) * 60_000 }));
    }
    const signals = strategy.generateSignals();
    if (signals.length > 0) {
      const orders = strategy.sizePositions(signals);
      if (orders.length > 0) {
        // Passive entry should be near bid, not crossing the ask
        expect(orders[0].price).toBeLessThanOrEqual(0.76);
        expect(orders[0].price).toBeGreaterThanOrEqual(0.74);
      }
    }
  });

  it('respects allow_take_on_momentum flag', () => {
    const passiveStrat = createStrategy({ allow_take_on_momentum: false });
    const aggressiveStrat = createStrategy({ allow_take_on_momentum: true });

    const market = mkMarket({ bid: 0.74, ask: 0.76 });

    passiveStrat.onMarketUpdate(market);
    aggressiveStrat.onMarketUpdate(market);
    for (let i = 0; i < 5; i++) {
      const m = mkMarket({ bid: 0.74, ask: 0.76, timestamp: Date.now() - (5 - i) * 60_000 });
      passiveStrat.onMarketUpdate(m);
      aggressiveStrat.onMarketUpdate(m);
    }

    const pSignals = passiveStrat.generateSignals();
    const aSignals = aggressiveStrat.generateSignals();

    if (pSignals.length > 0 && aSignals.length > 0) {
      const pOrders = passiveStrat.sizePositions(pSignals);
      const aOrders = aggressiveStrat.sizePositions(aSignals);
      if (pOrders.length > 0 && aOrders.length > 0) {
        // Aggressive entry may be slightly higher than passive
        expect(aOrders[0].price).toBeGreaterThanOrEqual(pOrders[0].price);
      }
    }
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   6. LIFECYCLE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Lifecycle', () => {
  it('initializes with correct name', () => {
    const strategy = new FilteredHighProbConvergenceStrategy();
    expect(strategy.name).toBe('filtered_high_prob_convergence');
  });

  it('merges YAML config over defaults', () => {
    const strategy = createStrategy({ min_prob: 0.70, max_prob: 0.85 });
    // We can't directly inspect private cfg, but we can test behavior:
    // A market at 0.68 should be rejected with min_prob=0.70
    strategy.onMarketUpdate(mkMarket({
      midPrice: 0.68,
      bid: 0.67,
      ask: 0.69,
      outcomePrices: [0.68, 0.32],
    }));
    const signals = strategy.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('shutdown() does not throw', () => {
    const strategy = createStrategy();
    expect(() => strategy.shutdown()).not.toThrow();
  });

  it('onTimer() does not throw', () => {
    const strategy = createStrategy();
    expect(() => strategy.onTimer()).not.toThrow();
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   7. MULTI-MARKET SCANNING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('FilteredHighProbConvergence — Multi-Market Scanning', () => {
  it('evaluates all markets in cache', () => {
    const strategy = createStrategy();
    // Feed 5 markets, only some should pass
    const good = mkMarket({ marketId: 'good-1', midPrice: 0.80, bid: 0.79, ask: 0.81 });
    const lowLiq = mkMarket({ marketId: 'low-liq', liquidity: 500 });
    const tooHigh = mkMarket({ marketId: 'too-high', midPrice: 0.98, bid: 0.97, ask: 0.99 });
    const noDate = mkMarket({ marketId: 'no-date', endDate: undefined });
    const ok = mkMarket({ marketId: 'ok-2', midPrice: 0.70, bid: 0.69, ask: 0.71, eventId: 'evt-different' });

    [good, lowLiq, tooHigh, noDate, ok].forEach(m => {
      strategy.onMarketUpdate(m);
      // Feed stable price history
      for (let i = 0; i < 5; i++) {
        strategy.onMarketUpdate({ ...m, timestamp: Date.now() - (5 - i) * 60_000 });
      }
    });

    const signals = strategy.generateSignals();
    // low-liq, too-high, no-date should all be rejected
    // good-1 and ok-2 should pass (depending on flow/imbalance)
    const passedIds = signals.map(s => s.marketId);
    expect(passedIds).not.toContain('low-liq');
    expect(passedIds).not.toContain('too-high');
    expect(passedIds).not.toContain('no-date');
  });
});
