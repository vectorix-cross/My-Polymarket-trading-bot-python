import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CopyTradeStrategy, DEFAULT_COPY_TRADE_CONFIG, CopyTradeConfig } from '../src/strategies/copy_trading/copy_trade_strategy';
import { MarketData, WalletState, Signal } from '../src/types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Helpers
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const WHALE_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WHALE_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function mkMarket(overrides: Partial<MarketData> = {}): MarketData {
  return {
    marketId: 'mkt-1',
    question: 'Will X happen?',
    slug: 'will-x-happen',
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.60, 0.40],
    clobTokenIds: ['tok-1', 'tok-2'],
    midPrice: 0.60,
    bid: 0.59,
    ask: 0.61,
    spread: 0.02,
    volume24h: 20_000,
    liquidity: 5_000,
    timestamp: Date.now(),
    ...overrides,
  };
}

function mkWallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    walletId: 'paper_copy_trade',
    mode: 'PAPER',
    assignedStrategy: 'copy_trade',
    capitalAllocated: 10_000,
    availableBalance: 10_000,
    openPositions: [],
    realizedPnl: 0,
    riskLimits: {
      maxPositionSize: 500,
      maxExposurePerMarket: 500,
      maxDailyLoss: 500,
      maxOpenTrades: 30,
      maxDrawdown: 0.15,
    },
    ...overrides,
  };
}

/** Build a mock data-api response for whale trades */
function mkApiTrades(trades: Array<{
  hash?: string;
  wallet?: string;
  side?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  conditionId?: string;
  outcome?: string;
}>): object[] {
  return trades.map((t) => ({
    transactionHash: t.hash ?? `0x${Math.random().toString(16).slice(2, 18)}`,
    proxyWallet: t.wallet ?? WHALE_A,
    side: t.side ?? 'BUY',
    size: t.size ?? 100,
    price: t.price ?? 0.60,
    timestamp: t.timestamp ?? Math.floor(Date.now() / 1000),
    conditionId: t.conditionId ?? 'mkt-1',
    outcome: t.outcome ?? 'Yes',
    asset: t.conditionId ?? 'mkt-1',
  }));
}

function createStrategy(cfgOverrides: Partial<CopyTradeConfig> = {}): CopyTradeStrategy {
  const strategy = new CopyTradeStrategy();
  const config = {
    ...DEFAULT_COPY_TRADE_CONFIG,
    whale_addresses: [WHALE_A],
    ...cfgOverrides,
  };
  strategy.initialize({
    wallet: mkWallet(),
    config: config as unknown as Record<string, unknown>,
  });
  return strategy;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Mock fetch for data API calls
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. INITIALISATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Initialisation', () => {
  it('initialises with correct name', () => {
    const s = createStrategy();
    expect(s.name).toBe('copy_trade');
  });

  it('registers in strategy registry', async () => {
    const { STRATEGY_REGISTRY } = await import('../src/strategies/registry');
    expect(STRATEGY_REGISTRY.copy_trade).toBeDefined();
    const instance = new STRATEGY_REGISTRY.copy_trade();
    expect(instance.name).toBe('copy_trade');
  });

  it('uses default config when none provided', () => {
    const s = createStrategy();
    const cfg = s.getConfig();
    expect(cfg.copy_mode).toBe('mirror');
    expect(cfg.size_mode).toBe('fixed');
    expect(cfg.fixed_size).toBe(10);
    expect(cfg.max_open_positions).toBe(15);
  });

  it('overrides defaults with provided config', () => {
    const s = createStrategy({
      copy_mode: 'inverse',
      size_mode: 'proportional',
      fixed_size: 25,
      max_open_positions: 5,
    });
    const cfg = s.getConfig();
    expect(cfg.copy_mode).toBe('inverse');
    expect(cfg.size_mode).toBe('proportional');
    expect(cfg.fixed_size).toBe(25);
    expect(cfg.max_open_positions).toBe(5);
  });

  it('initialises per-whale performance trackers', () => {
    const s = createStrategy({ whale_addresses: [WHALE_A, WHALE_B] });
    const perf = s.getWhalePerformance();
    expect(perf.size).toBe(2);
    expect(perf.get(WHALE_A.toLowerCase())).toBeDefined();
    expect(perf.get(WHALE_B.toLowerCase())).toBeDefined();
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   2. WHALE TRADE POLLING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Polling', () => {
  it('polls data API on timer', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ side: 'BUY', size: 100, price: 0.60 }]),
    });

    await s.onTimer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain(`maker_address=${WHALE_A}`);
  });

  it('does not poll before interval elapses', async () => {
    const s = createStrategy({ poll_interval_seconds: 9999 });
    await s.onTimer();
    // First call always polls (lastPollAt starts at 0)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await s.onTimer();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('generates signals from new whale BUY trades', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{
        hash: 'tx-001',
        side: 'BUY',
        size: 200,
        price: 0.60,
        conditionId: 'mkt-1',
        outcome: 'Yes',
      }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals.length).toBe(1);
    expect(signals[0].marketId).toBe('mkt-1');
    expect(signals[0].outcome).toBe('YES');
    expect(signals[0].side).toBe('BUY');
  });

  it('does not duplicate signals for already-seen trades', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    s.onMarketUpdate(mkMarket());

    const trades = mkApiTrades([{ hash: 'tx-dup', side: 'BUY' }]);
    fetchMock.mockResolvedValue({ ok: true, json: async () => trades });

    await s.onTimer();
    const sig1 = s.generateSignals();
    expect(sig1.length).toBe(1);

    // Poll again with same trade
    await s.onTimer();
    const sig2 = s.generateSignals();
    expect(sig2.length).toBe(0); // already seen
  });

  it('ignores whale SELL trades for signal generation', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ side: 'SELL', size: 100 }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals.length).toBe(0);
  });

  it('handles API failures gracefully', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    fetchMock.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await expect(s.onTimer()).resolves.not.toThrow();
    const signals = s.generateSignals();
    expect(signals.length).toBe(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   3. COPY MODE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Copy Modes', () => {
  it('mirrors whale direction in mirror mode', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, copy_mode: 'mirror' });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ side: 'BUY', outcome: 'Yes' }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals[0].outcome).toBe('YES');
  });

  it('inverts whale direction in inverse mode', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, copy_mode: 'inverse' });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ side: 'BUY', outcome: 'Yes' }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals[0].outcome).toBe('NO'); // inverted
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4. POSITION SIZING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Sizing', () => {
  it('sizes with fixed mode', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, size_mode: 'fixed', fixed_size: 15 });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-sz1', side: 'BUY', size: 500 }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    const orders = s.sizePositions(signals);
    expect(orders.length).toBe(1);
    expect(orders[0].size).toBe(15);
  });

  it('sizes with proportional mode', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      size_mode: 'proportional',
      proportional_factor: 0.10,
    });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-sz2', side: 'BUY', size: 200 }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    const orders = s.sizePositions(signals);
    expect(orders.length).toBe(1);
    expect(orders[0].size).toBe(20); // 200 * 0.10
  });

  it('respects max_shares_per_order cap', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      size_mode: 'fixed',
      fixed_size: 999,
      max_shares_per_order: 25,
    });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-cap', side: 'BUY' }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    const orders = s.sizePositions(signals);
    expect(orders[0].size).toBeLessThanOrEqual(25);
  });

  it('refuses to trade with insufficient balance', async () => {
    const s = new CopyTradeStrategy();
    s.initialize({
      wallet: mkWallet({ availableBalance: 100, capitalAllocated: 10_000 }),
      config: {
        ...DEFAULT_COPY_TRADE_CONFIG,
        whale_addresses: [WHALE_A],
        poll_interval_seconds: 0,
      } as unknown as Record<string, unknown>,
    });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-low', side: 'BUY' }]),
    });

    await s.onTimer();
    const orders = s.sizePositions(s.generateSignals());
    expect(orders.length).toBe(0); // 100 < 10000 * 0.05 = 500
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   5. FILTERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Filters', () => {
  it('rejects trades below min_trade_size_usd', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, min_trade_size_usd: 100 });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-small', side: 'BUY', size: 10, price: 0.50 }]), // $5
    });

    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('rejects trades above max_trade_size_usd', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, max_trade_size_usd: 1000 });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-huge', side: 'BUY', size: 5000, price: 0.60 }]), // $3000
    });

    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('rejects trades older than max_trade_age_seconds', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, max_trade_age_seconds: 60 });

    const oldTimestamp = Math.floor(Date.now() / 1000) - 300; // 5 min ago
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-old', side: 'BUY', timestamp: oldTimestamp }]),
    });

    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('rejects blacklisted markets', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      blacklist_markets: ['mkt-1'],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-bl', side: 'BUY', conditionId: 'mkt-1' }]),
    });

    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('only trades whitelisted markets when whitelist is set', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      whitelist_markets: ['mkt-allowed'],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([
        { hash: 'tx-wl1', side: 'BUY', conditionId: 'mkt-1' },       // not whitelisted
        { hash: 'tx-wl2', side: 'BUY', conditionId: 'mkt-allowed' }, // whitelisted
      ]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals.length).toBe(1);
    expect(signals[0].marketId).toBe('mkt-allowed');
  });

  it('rejects trades in markets with low liquidity', async () => {
    const s = createStrategy({ poll_interval_seconds: 0, min_market_liquidity: 10_000 });
    s.onMarketUpdate(mkMarket({ liquidity: 500 })); // below threshold

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-liq', side: 'BUY' }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    const orders = s.sizePositions(signals);
    expect(orders.length).toBe(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   6. POSITION MANAGEMENT — EXITS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Exit Logic', () => {
  async function setupWithPosition(cfgOverrides: Partial<CopyTradeConfig> = {}): Promise<CopyTradeStrategy> {
    const s = createStrategy({ poll_interval_seconds: 0, ...cfgOverrides });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-pos', side: 'BUY', conditionId: 'mkt-1' }]),
    });

    await s.onTimer();
    const signals = s.generateSignals();
    const orders = s.sizePositions(signals);
    expect(orders.length).toBe(1);

    // Simulate fill
    s.notifyFill(orders[0]);
    expect(s.getPositions().size).toBe(1);

    return s;
  }

  it('exits on take profit', async () => {
    const s = await setupWithPosition({ take_profit_bps: 100 });

    // Price moved up significantly → TP
    s.onMarketUpdate(mkMarket({ outcomePrices: [0.72, 0.28] })); // +20% from 0.60
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits.length).toBe(1);
    expect(exits[0].side).toBe('SELL');
  });

  it('exits on stop loss', async () => {
    const s = await setupWithPosition({ stop_loss_bps: 50 });

    // Price dropped
    s.onMarketUpdate(mkMarket({ outcomePrices: [0.55, 0.45] })); // -8.3%
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits.length).toBe(1);
  });

  it('exits on time expiry', async () => {
    const s = await setupWithPosition({ time_exit_minutes: 0.0001 }); // ~6ms

    // Wait enough for the hold time to exceed threshold
    await new Promise((r) => setTimeout(r, 50));
    s.onMarketUpdate(mkMarket());
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits.length).toBe(1);
  });

  it('exits when whale exits', async () => {
    const s = await setupWithPosition({ exit_on_whale_exit: true });

    // Simulate whale sell in same market
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{
        hash: 'tx-exit',
        side: 'SELL',
        conditionId: 'mkt-1',
        wallet: WHALE_A,
      }]),
    });
    await s.onTimer();

    // managePositions should detect the whale exit
    s.onMarketUpdate(mkMarket());
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits.length).toBe(1);
  });

  it('does not exit when whale exit detection is disabled', async () => {
    const s = await setupWithPosition({ exit_on_whale_exit: false });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-noexit', side: 'SELL', conditionId: 'mkt-1' }]),
    });
    await s.onTimer();

    s.onMarketUpdate(mkMarket());
    s.managePositions();
    const exits = s.drainExitOrders();
    expect(exits.length).toBe(0); // no exit — price hasn't moved enough for TP/SL
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   7. RISK MANAGEMENT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Risk Management', () => {
  it('respects max_open_positions', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      max_open_positions: 1,
    });
    s.onMarketUpdate(mkMarket({ marketId: 'mkt-1' }));
    s.onMarketUpdate(mkMarket({ marketId: 'mkt-2' }));

    // First trade
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-r1', side: 'BUY', conditionId: 'mkt-1' }]),
    });
    await s.onTimer();
    const orders1 = s.sizePositions(s.generateSignals());
    expect(orders1.length).toBe(1);
    s.notifyFill(orders1[0]);

    // Second trade — should be rejected (at capacity)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-r2', side: 'BUY', conditionId: 'mkt-2' }]),
    });
    await s.onTimer();
    const orders2 = s.sizePositions(s.generateSignals());
    expect(orders2.length).toBe(0);
  });

  it('respects max_daily_volume_usd', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      max_daily_volume_usd: 10, // very low
      fixed_size: 100,
    });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-vol', side: 'BUY' }]),
    });

    await s.onTimer();
    const orders = s.sizePositions(s.generateSignals());
    expect(orders.length).toBe(0); // 100 * 0.60 = $60 > $10 daily cap
  });

  it('tracks per-whale performance', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-perf', side: 'BUY' }]),
    });

    await s.onTimer();
    const orders = s.sizePositions(s.generateSignals());
    s.notifyFill(orders[0]);

    const perf = s.getWhalePerformance().get(WHALE_A.toLowerCase());
    expect(perf?.tradesCopied).toBe(1);
  });

  it('pauses whale after consecutive losses', async () => {
    const s = createStrategy({
      poll_interval_seconds: 0,
      max_consecutive_losses: 2,
      cooldown_after_loss_seconds: 999,
      stop_loss_bps: 10,
    });

    // Simulate 2 losing trades
    for (let i = 0; i < 2; i++) {
      const mktId = `mkt-loss-${i}`;
      s.onMarketUpdate(mkMarket({ marketId: mktId }));
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => mkApiTrades([{
          hash: `tx-loss-${i}`,
          side: 'BUY',
          conditionId: mktId,
        }]),
      });
      await s.onTimer();
      const orders = s.sizePositions(s.generateSignals());
      if (orders.length > 0) {
        s.notifyFill(orders[0]);
        // Price drops → stop loss
        s.onMarketUpdate(mkMarket({ marketId: mktId, outcomePrices: [0.50, 0.50] }));
        s.managePositions();
        s.drainExitOrders();
      }
    }

    const perf = s.getWhalePerformance().get(WHALE_A.toLowerCase());
    expect(perf?.consecutiveLosses).toBe(2);
    expect(perf!.pausedUntil).toBeGreaterThan(Date.now());
  });

  it('reports stats correctly', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    s.onMarketUpdate(mkMarket());

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => mkApiTrades([{ hash: 'tx-stat', side: 'BUY' }]),
    });

    await s.onTimer();
    const orders = s.sizePositions(s.generateSignals());
    s.notifyFill(orders[0]);

    const stats = s.getStats();
    expect(stats.totalCopied).toBe(1);
    expect(stats.openPositions).toBe(1);
    expect(stats.drawdownPaused).toBe(false);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   8. MULTI-WHALE SUPPORT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Multi-Whale', () => {
  it('follows multiple whales', async () => {
    const s = createStrategy({
      whale_addresses: [WHALE_A, WHALE_B],
      poll_interval_seconds: 0,
    });
    s.onMarketUpdate(mkMarket({ marketId: 'mkt-a' }));
    s.onMarketUpdate(mkMarket({ marketId: 'mkt-b' }));

    let callCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes(WHALE_A)) {
        return { ok: true, json: async () => mkApiTrades([{ hash: 'tx-a', side: 'BUY', conditionId: 'mkt-a', wallet: WHALE_A }]) };
      }
      return { ok: true, json: async () => mkApiTrades([{ hash: 'tx-b', side: 'BUY', conditionId: 'mkt-b', wallet: WHALE_B }]) };
    });

    await s.onTimer();
    const signals = s.generateSignals();
    expect(signals.length).toBe(2);
    expect(callCount).toBe(2); // one per whale
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   9. EDGE CASES
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
describe('CopyTradeStrategy — Edge Cases', () => {
  it('handles empty whale_addresses gracefully', async () => {
    const s = createStrategy({ whale_addresses: [], poll_interval_seconds: 0 });
    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('handles non-ok API response', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await s.onTimer();
    expect(s.generateSignals().length).toBe(0);
  });

  it('prunes seen-trade IDs when set grows large', async () => {
    const s = createStrategy({ poll_interval_seconds: 0 });

    // Manually add 10001 seen IDs
    for (let i = 0; i < 10_001; i++) {
      (s as any).seenTradeIds.add(`tx-${i}`);
    }
    expect((s as any).seenTradeIds.size).toBe(10_001);

    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    await s.onTimer();

    // Should have been pruned to ~5000
    expect((s as any).seenTradeIds.size).toBeLessThanOrEqual(5_001);
  });

  it('shuts down cleanly', () => {
    const s = createStrategy();
    expect(() => s.shutdown()).not.toThrow();
  });
});
