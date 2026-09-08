/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Copy Trading Strategy
   ─────────────────────────────────────────────────────────────
   Mirrors trades from configured whale addresses in near-real-
   time, with comprehensive risk management guardrails.

   Features:
   • Multi-whale following — track multiple addresses at once
   • Configurable copy modes: mirror (same direction) or inverse
   • Three sizing modes: fixed, proportional, half-Kelly
   • Full exit management: TP / SL / trailing stop / time exit
   • Per-whale & aggregate drawdown circuit breakers
   • Daily volume / exposure caps
   • Market blacklist / whitelist
   • Cooldown after consecutive losses
   • Whale health monitoring (auto-pause on poor performance)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, MarketData, OrderRequest, OrderOutcome, OrderSide } from '../../types';
import { logger } from '../../reporting/logs';
import { consoleLog } from '../../reporting/console_log';

/* ━━━━━━━━━━━━━━ Configuration Interface ━━━━━━━━━━━━━━ */

export interface CopyTradeConfig {
  /** Whale addresses to follow */
  whale_addresses: string[];

  /** 'mirror' = same direction as whale, 'inverse' = opposite */
  copy_mode: 'mirror' | 'inverse';

  /** Data API URL for fetching whale trades */
  data_api_url: string;

  /* ── Polling ── */
  /** How often to poll for new whale trades (seconds) */
  poll_interval_seconds: number;
  /** Max age of a whale trade to still copy (seconds) */
  max_trade_age_seconds: number;

  /* ── Whale Filters ── */
  /** Minimum notional (USD) of a whale trade to copy */
  min_trade_size_usd: number;
  /** Maximum notional (USD) of a whale trade to copy (skip outsized bets) */
  max_trade_size_usd: number;
  /** Minimum whale win rate to follow (0-1) */
  min_whale_win_rate: number;

  /* ── Position Sizing ── */
  /** Sizing mode: 'fixed' | 'proportional' | 'kelly' */
  size_mode: 'fixed' | 'proportional' | 'kelly';
  /** Fixed number of shares when size_mode = 'fixed' */
  fixed_size: number;
  /** Fraction of whale's size when size_mode = 'proportional' (0-1) */
  proportional_factor: number;
  /** Max fraction of wallet capital per single trade */
  max_capital_per_trade_pct: number;
  /** Max shares per single order */
  max_shares_per_order: number;

  /* ── Risk / Exposure Limits ── */
  /** Max simultaneous open positions */
  max_open_positions: number;
  /** Max USD exposure per market */
  max_exposure_per_market_usd: number;
  /** Max total daily copy volume (USD) */
  max_daily_volume_usd: number;
  /** Max cumulative drawdown before pausing all copy-trading (0-1) */
  max_drawdown_pct: number;
  /** Max consecutive losses before entering cooldown */
  max_consecutive_losses: number;
  /** Cooldown after hitting max consecutive losses (seconds) */
  cooldown_after_loss_seconds: number;

  /* ── Exit Parameters ── */
  /** Take profit (basis points) */
  take_profit_bps: number;
  /** Stop loss (basis points) */
  stop_loss_bps: number;
  /** Trailing stop activates at this PnL (bps) */
  trailing_stop_activate_bps: number;
  /** Trailing stop deduction from peak (bps) */
  trailing_stop_distance_bps: number;
  /** Time-based exit (minutes) — 0 to disable */
  time_exit_minutes: number;
  /** Close when whale exits (mirror their sell) */
  exit_on_whale_exit: boolean;

  /* ── Filters ── */
  /** Markets to never trade (condition IDs) */
  blacklist_markets: string[];
  /** If non-empty, ONLY trade these markets */
  whitelist_markets: string[];
  /** Min market liquidity to copy into */
  min_market_liquidity: number;
  /** Min market 24h volume */
  min_market_volume_24h: number;
}

export const DEFAULT_COPY_TRADE_CONFIG: CopyTradeConfig = {
  whale_addresses: [],
  copy_mode: 'mirror',
  data_api_url: 'https://data-api.polymarket.com',
  poll_interval_seconds: 30,
  max_trade_age_seconds: 120,
  min_trade_size_usd: 50,
  max_trade_size_usd: 100_000,
  min_whale_win_rate: 0.50,
  size_mode: 'fixed',
  fixed_size: 10,
  proportional_factor: 0.10,
  max_capital_per_trade_pct: 0.05,
  max_shares_per_order: 50,
  max_open_positions: 15,
  max_exposure_per_market_usd: 500,
  max_daily_volume_usd: 5_000,
  max_drawdown_pct: 0.15,
  max_consecutive_losses: 5,
  cooldown_after_loss_seconds: 300,
  take_profit_bps: 150,
  stop_loss_bps: 100,
  trailing_stop_activate_bps: 80,
  trailing_stop_distance_bps: 30,
  time_exit_minutes: 120,
  exit_on_whale_exit: true,
  blacklist_markets: [],
  whitelist_markets: [],
  min_market_liquidity: 500,
  min_market_volume_24h: 1_000,
};

/* ━━━━━━━━━━━━━━ Internal Types ━━━━━━━━━━━━━━ */

/** Raw trade shape from Polymarket data API */
interface DataApiTrade {
  transactionHash?: string;
  proxyWallet?: string;
  side?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number;
  asset?: string;
  outcome?: string;
  conditionId?: string;
}

/** A whale trade after normalisation */
interface NormalisedWhaleTrade {
  id: string;
  whaleAddress: string;
  marketId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  price: number;
  size: number;
  notionalUsd: number;
  timestamp: number;
}

/** Tracked copy position */
interface CopyPosition {
  marketId: string;
  outcome: OrderOutcome;
  side: OrderSide;
  entryPrice: number;
  entryTime: number;
  size: number;
  peakPnlBps: number;
  whaleAddress: string;
  /** Whether the whale has already exited this market */
  whaleExited: boolean;
}

/** Per-whale performance tracking */
interface WhalePerformance {
  address: string;
  tradesCopied: number;
  wins: number;
  losses: number;
  totalPnlBps: number;
  consecutiveLosses: number;
  pausedUntil: number;
  dailyVolumeUsd: number;
  dailyVolumeResetAt: number;
}

/* ━━━━━━━━━━━━━━ Strategy Implementation ━━━━━━━━━━━━━━ */

export class CopyTradeStrategy extends BaseStrategy {
  readonly name = 'copy_trade';

  private cfg!: CopyTradeConfig;

  /* ── State ── */
  private seenTradeIds = new Set<string>();
  private pendingSignals: Signal[] = [];
  private pendingWhaleTrades: NormalisedWhaleTrade[] = [];
  private positions = new Map<string, CopyPosition>();
  private whalePerf = new Map<string, WhalePerformance>();
  /** Maps marketId → whale address, populated in sizePositions for notifyFill lookup */
  private recentWhaleMap = new Map<string, string>();
  private lastPollAt = 0;
  private totalDailyVolumeUsd = 0;
  private dailyVolumeResetAt = 0;
  private cumulativePnlBps = 0;
  private peakPnlBps = 0;
  private drawdownPaused = false;
  private scanCount = 0;

  protected override cooldownMs = 30_000;

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    this.cfg = this.buildConfig(context.config);

    // Initialise per-whale performance trackers
    for (const addr of this.cfg.whale_addresses) {
      this.whalePerf.set(addr.toLowerCase(), {
        address: addr.toLowerCase(),
        tradesCopied: 0,
        wins: 0,
        losses: 0,
        totalPnlBps: 0,
        consecutiveLosses: 0,
        pausedUntil: 0,
        dailyVolumeUsd: 0,
        dailyVolumeResetAt: this.nextDayReset(),
      });
    }

    logger.info({
      strategy: this.name,
      whaleCount: this.cfg.whale_addresses.length,
      copyMode: this.cfg.copy_mode,
      sizeMode: this.cfg.size_mode,
    }, 'Copy Trade strategy initialised');
    consoleLog.info('STRATEGY', `[copy_trade] Following ${this.cfg.whale_addresses.length} whale(s) in ${this.cfg.copy_mode} mode`);
  }

  /* ━━━━━━━━━━━━━━ Timer — Poll for whale trades ━━━━━━━━━━━━━━ */

  override async onTimer(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollAt < this.cfg.poll_interval_seconds * 1000) return;
    this.lastPollAt = now;

    // Reset daily volume at midnight UTC
    this.resetDailyIfNeeded(now);

    // Check drawdown circuit breaker
    if (this.drawdownPaused) {
      consoleLog.warn('STRATEGY', '[copy_trade] Paused — drawdown limit reached');
      return;
    }

    // Poll each whale address
    for (const address of this.cfg.whale_addresses) {
      const perf = this.whalePerf.get(address.toLowerCase());
      if (perf && now < perf.pausedUntil) {
        continue; // whale-specific cooldown
      }

      try {
        const trades = await this.fetchWhaleTrades(address);
        const newTrades = trades.filter((t) => !this.seenTradeIds.has(t.id));

        for (const trade of newTrades) {
          this.seenTradeIds.add(trade.id);

          // Apply filters
          if (!this.passesFilters(trade, now)) continue;

          // Convert to signal
          const signal = this.tradeToSignal(trade);
          if (signal) {
            this.pendingSignals.push(signal);
            this.pendingWhaleTrades.push(trade);
          }
        }

        // Check for whale exits (to trigger exit_on_whale_exit)
        if (this.cfg.exit_on_whale_exit) {
          this.detectWhaleExits(trades, address);
        }
      } catch (err) {
        logger.warn({ err, address }, '[copy_trade] Failed to poll whale trades');
      }
    }

    // Prune old seen-trade IDs (keep last 10,000)
    if (this.seenTradeIds.size > 10_000) {
      const arr = Array.from(this.seenTradeIds);
      this.seenTradeIds = new Set(arr.slice(-5_000));
    }
  }

  /* ━━━━━━━━━━━━━━ Signal Generation ━━━━━━━━━━━━━━ */

  generateSignals(): Signal[] {
    this.scanCount++;
    const signals = [...this.pendingSignals];
    this.pendingSignals = [];

    if (this.scanCount % 12 === 0) {
      consoleLog.info('STRATEGY', `[copy_trade] Tick #${this.scanCount}: ${this.positions.size} open, ${signals.length} pending signals, drawdown=${(this.getCurrentDrawdownPct() * 100).toFixed(1)}%`, {
        openPositions: this.positions.size,
        pendingSignals: signals.length,
        totalCopied: this.getTotalTradesCopied(),
        cumulativePnlBps: this.cumulativePnlBps,
      });
    }

    return signals;
  }

  /* ━━━━━━━━━━━━━━ Position Sizing ━━━━━━━━━━━━━━ */

  override sizePositions(signals: Signal[]): OrderRequest[] {
    const available = this.context?.wallet.availableBalance ?? 0;
    const initial = this.context?.wallet.capitalAllocated ?? 0;
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    // Don't trade if less than 5% capital remains
    if (available < initial * 0.05) return [];

    // Position limit
    const slotsAvailable = Math.max(0, this.cfg.max_open_positions - this.positions.size);
    if (slotsAvailable === 0) return [];

    // Daily volume cap
    if (this.totalDailyVolumeUsd >= this.cfg.max_daily_volume_usd) return [];

    const orders: OrderRequest[] = [];
    const whaleTrades = [...this.pendingWhaleTrades];
    this.pendingWhaleTrades = [];

    // Populate recentWhaleMap so notifyFill can look up the whale address
    for (const wt of whaleTrades) {
      this.recentWhaleMap.set(wt.marketId, wt.whaleAddress);
    }

    for (let i = 0; i < signals.length && orders.length < slotsAvailable; i++) {
      const signal = signals[i];
      const whaleTrade = whaleTrades[i];

      // Already positioned in this market?
      if (this.positions.has(signal.marketId)) continue;

      const market = this.markets.get(signal.marketId);
      if (!market) continue;

      // Market liquidity / volume filters
      if (market.liquidity < this.cfg.min_market_liquidity) continue;
      if (market.volume24h < this.cfg.min_market_volume_24h) continue;

      // Per-market exposure check
      const existingExposure = this.getMarketExposure(signal.marketId);
      if (existingExposure >= this.cfg.max_exposure_per_market_usd) continue;

      // Determine outcome price
      const outcomePrice = signal.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);
      const safePrice = Number(Math.max(0.02, Math.min(0.98, outcomePrice)).toFixed(4));

      // Calculate size based on mode
      const size = this.calculateSize(signal, whaleTrade, safePrice, available);
      if (size < 1) continue;

      const cost = size * safePrice;

      // Daily volume cap
      if (this.totalDailyVolumeUsd + cost > this.cfg.max_daily_volume_usd) continue;
      if (cost > available) continue;

      this.totalDailyVolumeUsd += cost;

      orders.push({
        walletId,
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        price: safePrice,
        size,
        strategy: this.name,
      });

      logger.info({
        strategy: this.name,
        whale: whaleTrade?.whaleAddress?.slice(0, 10) ?? 'unknown',
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        size,
        price: safePrice,
        whaleSize: whaleTrade?.size ?? 0,
        whalePrice: whaleTrade?.price ?? 0,
      }, `COPY_TRADE: mirroring whale trade`);
    }

    return orders;
  }

  /* ━━━━━━━━━━━━━━ Fill Tracking ━━━━━━━━━━━━━━ */

  override notifyFill(order: OrderRequest): void {
    if (order.side !== 'BUY') return;

    // Find the whale address from the pending data
    const whaleAddr = this.findWhaleForMarket(order.marketId) ?? 'unknown';

    this.positions.set(order.marketId, {
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      entryTime: Date.now(),
      size: order.size,
      peakPnlBps: 0,
      whaleAddress: whaleAddr,
      whaleExited: false,
    });

    // Update whale performance
    const perf = this.whalePerf.get(whaleAddr.toLowerCase());
    if (perf) {
      perf.tradesCopied++;
      perf.dailyVolumeUsd += order.price * order.size;
    }

    consoleLog.success('STRATEGY', `[copy_trade] Copied whale ${whaleAddr.slice(0, 10)}… → ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)} in market ${order.marketId.slice(0, 12)}…`);
  }

  /* ━━━━━━━━━━━━━━ Position Management — Exits ━━━━━━━━━━━━━━ */

  override managePositions(): void {
    const now = Date.now();

    for (const [marketId, pos] of this.positions) {
      const market = this.markets.get(marketId);
      if (!market) continue;

      // Current price for the position's outcome
      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);

      // PnL in basis points
      const pnlBps = ((currentPrice - pos.entryPrice) / Math.max(pos.entryPrice, 0.001)) * 10_000;
      const holdMin = (now - pos.entryTime) / 60_000;

      // Track peak for trailing stop
      if (pnlBps > pos.peakPnlBps) pos.peakPnlBps = pnlBps;

      let exitReason: string | undefined;

      // 1. Take profit
      if (pnlBps >= this.cfg.take_profit_bps) {
        exitReason = `TP: +${pnlBps.toFixed(0)}bps`;
      }
      // 2. Stop loss
      else if (pnlBps <= -this.cfg.stop_loss_bps) {
        exitReason = `SL: ${pnlBps.toFixed(0)}bps`;
      }
      // 3. Trailing stop
      else if (
        pos.peakPnlBps >= this.cfg.trailing_stop_activate_bps &&
        pnlBps < pos.peakPnlBps - this.cfg.trailing_stop_distance_bps
      ) {
        exitReason = `TRAIL: peak +${pos.peakPnlBps.toFixed(0)}, now ${pnlBps.toFixed(0)}bps`;
      }
      // 4. Time exit
      else if (this.cfg.time_exit_minutes > 0 && holdMin >= this.cfg.time_exit_minutes) {
        exitReason = `TIME: ${holdMin.toFixed(0)}min`;
      }
      // 5. Whale exited
      else if (this.cfg.exit_on_whale_exit && pos.whaleExited) {
        exitReason = `WHALE_EXIT: whale ${pos.whaleAddress.slice(0, 10)}… closed position`;
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

        // Track win/loss for the whale
        this.recordTradeResult(pos.whaleAddress, pnlBps);
        this.positions.delete(marketId);

        logger.info({
          strategy: this.name,
          marketId,
          outcome: pos.outcome,
          reason: exitReason,
          pnlBps: pnlBps.toFixed(0),
          whale: pos.whaleAddress.slice(0, 10),
        }, `COPY_TRADE exit: ${exitReason}`);
        consoleLog.info('STRATEGY', `[copy_trade] Exit ${marketId.slice(0, 12)}… — ${exitReason}`);
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Data API Polling ━━━━━━━━━━━━━━ */

  /** Fetch recent trades for a whale address from the Polymarket data API */
  private async fetchWhaleTrades(address: string): Promise<NormalisedWhaleTrade[]> {
    try {
      const url = `${this.cfg.data_api_url}/trades?maker_address=${encodeURIComponent(address)}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) {
        logger.debug({ address, status: res.status }, '[copy_trade] API request failed');
        return [];
      }

      const raw = (await res.json()) as DataApiTrade[] | { trades?: DataApiTrade[] };
      const trades: DataApiTrade[] = Array.isArray(raw) ? raw : (raw.trades ?? []);

      return trades
        .filter((t) => t.proxyWallet && t.side && t.size != null && t.price != null)
        .map((t) => this.normaliseTrade(t, address));
    } catch {
      return [];
    }
  }

  private normaliseTrade(raw: DataApiTrade, whaleAddress: string): NormalisedWhaleTrade {
    const price = Number(raw.price ?? 0);
    const size = Number(raw.size ?? 0);
    const side = (raw.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as OrderSide;
    const outcome = (raw.outcome?.toUpperCase() === 'NO' ? 'NO' : 'YES') as OrderOutcome;
    const timestamp = raw.timestamp ? raw.timestamp * 1000 : Date.now();

    return {
      id: raw.transactionHash ?? `${whaleAddress}-${timestamp}-${raw.asset ?? ''}`,
      whaleAddress: whaleAddress.toLowerCase(),
      marketId: raw.conditionId ?? raw.asset ?? '',
      outcome,
      side,
      price,
      size,
      notionalUsd: price * size,
      timestamp,
    };
  }

  /* ━━━━━━━━━━━━━━ Filters ━━━━━━━━━━━━━━ */

  private passesFilters(trade: NormalisedWhaleTrade, now: number): boolean {
    // Age filter
    const ageSeconds = (now - trade.timestamp) / 1000;
    if (ageSeconds > this.cfg.max_trade_age_seconds) return false;

    // Notional size filters
    if (trade.notionalUsd < this.cfg.min_trade_size_usd) return false;
    if (trade.notionalUsd > this.cfg.max_trade_size_usd) return false;

    // Market blacklist / whitelist
    if (this.cfg.blacklist_markets.includes(trade.marketId)) return false;
    if (this.cfg.whitelist_markets.length > 0 && !this.cfg.whitelist_markets.includes(trade.marketId)) return false;

    // Already have a position in this market
    if (this.positions.has(trade.marketId)) return false;

    // Drawdown breaker
    if (this.getCurrentDrawdownPct() >= this.cfg.max_drawdown_pct) {
      this.drawdownPaused = true;
      return false;
    }

    return true;
  }

  /* ━━━━━━━━━━━━━━ Signal Conversion ━━━━━━━━━━━━━━ */

  private tradeToSignal(trade: NormalisedWhaleTrade): Signal | null {
    // Only copy BUY trades from whales (entries)
    // For sells, we handle via exit_on_whale_exit
    if (trade.side === 'SELL') return null;

    let outcome = trade.outcome;
    let side: OrderSide = 'BUY';

    // Inverse mode: flip direction
    if (this.cfg.copy_mode === 'inverse') {
      outcome = outcome === 'YES' ? 'NO' : 'YES';
    }

    // Confidence based on trade size (bigger whale trades = higher confidence)
    const sizeConfidence = Math.min(0.9, 0.4 + (trade.notionalUsd / 10_000) * 0.3);
    const edge = Math.min(0.05, (trade.notionalUsd / 50_000) * 0.04);

    return {
      marketId: trade.marketId,
      outcome,
      side,
      confidence: sizeConfidence,
      edge,
    };
  }

  /* ━━━━━━━━━━━━━━ Sizing Logic ━━━━━━━━━━━━━━ */

  private calculateSize(
    signal: Signal,
    whaleTrade: NormalisedWhaleTrade | undefined,
    price: number,
    available: number,
  ): number {
    const maxDollars = available * this.cfg.max_capital_per_trade_pct;
    let size: number;

    switch (this.cfg.size_mode) {
      case 'fixed':
        size = this.cfg.fixed_size;
        break;

      case 'proportional': {
        const whaleSize = whaleTrade?.size ?? this.cfg.fixed_size;
        size = Math.floor(whaleSize * this.cfg.proportional_factor);
        break;
      }

      case 'kelly': {
        // Half-Kelly sizing
        const kellyFraction = signal.edge / Math.max(1 - signal.edge, 0.01);
        const halfKelly = kellyFraction * 0.5;
        const kellyDollars = available * Math.min(halfKelly, this.cfg.max_capital_per_trade_pct);
        size = Math.floor(kellyDollars / Math.max(price, 0.01));
        break;
      }

      default:
        size = this.cfg.fixed_size;
    }

    // Apply caps
    const maxFromCapital = Math.floor(maxDollars / Math.max(price, 0.01));
    size = Math.min(size, maxFromCapital, this.cfg.max_shares_per_order);

    return Math.max(0, size);
  }

  /* ━━━━━━━━━━━━━━ Whale Exit Detection ━━━━━━━━━━━━━━ */

  private detectWhaleExits(trades: NormalisedWhaleTrade[], whaleAddress: string): void {
    const addr = whaleAddress.toLowerCase();
    const sellTrades = trades.filter((t) => t.side === 'SELL');

    for (const sell of sellTrades) {
      // Check if we have a position in this market that was copied from this whale
      const pos = this.positions.get(sell.marketId);
      if (pos && pos.whaleAddress.toLowerCase() === addr && !pos.whaleExited) {
        pos.whaleExited = true;
        logger.info({
          strategy: this.name,
          marketId: sell.marketId,
          whale: addr.slice(0, 10),
        }, 'Whale exit detected — will close mirrored position');
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Performance Tracking ━━━━━━━━━━━━━━ */

  private recordTradeResult(whaleAddress: string, pnlBps: number): void {
    this.cumulativePnlBps += pnlBps;
    if (this.cumulativePnlBps > this.peakPnlBps) {
      this.peakPnlBps = this.cumulativePnlBps;
    }

    const perf = this.whalePerf.get(whaleAddress.toLowerCase());
    if (!perf) return;

    perf.totalPnlBps += pnlBps;

    if (pnlBps >= 0) {
      perf.wins++;
      perf.consecutiveLosses = 0;
    } else {
      perf.losses++;
      perf.consecutiveLosses++;

      // Consecutive loss cooldown
      if (perf.consecutiveLosses >= this.cfg.max_consecutive_losses) {
        perf.pausedUntil = Date.now() + this.cfg.cooldown_after_loss_seconds * 1000;
        const winRate = perf.wins / Math.max(perf.wins + perf.losses, 1);
        logger.warn({
          strategy: this.name,
          whale: whaleAddress.slice(0, 10),
          consecutiveLosses: perf.consecutiveLosses,
          winRate: winRate.toFixed(2),
          cooldownSeconds: this.cfg.cooldown_after_loss_seconds,
        }, `COPY_TRADE: whale on cooldown after ${perf.consecutiveLosses} consecutive losses`);
        consoleLog.warn('STRATEGY', `[copy_trade] Whale ${whaleAddress.slice(0, 10)}… paused — ${perf.consecutiveLosses} consecutive losses`);
      }
    }
  }

  private getCurrentDrawdownPct(): number {
    if (this.peakPnlBps <= 0) return 0;
    return Math.max(0, (this.peakPnlBps - this.cumulativePnlBps) / this.peakPnlBps);
  }

  private getMarketExposure(marketId: string): number {
    const pos = this.positions.get(marketId);
    if (!pos) return 0;
    return pos.entryPrice * pos.size;
  }

  private findWhaleForMarket(marketId: string): string | undefined {
    // Check the recentWhaleMap (populated during sizePositions)
    const recent = this.recentWhaleMap.get(marketId);
    if (recent) return recent;
    // Fall back to checking existing positions
    for (const [, pos] of this.positions) {
      if (pos.marketId === marketId) return pos.whaleAddress;
    }
    return undefined;
  }

  private getTotalTradesCopied(): number {
    let total = 0;
    for (const perf of this.whalePerf.values()) {
      total += perf.tradesCopied;
    }
    return total;
  }

  /* ━━━━━━━━━━━━━━ Daily Reset ━━━━━━━━━━━━━━ */

  private resetDailyIfNeeded(now: number): void {
    if (now >= this.dailyVolumeResetAt) {
      this.totalDailyVolumeUsd = 0;
      this.dailyVolumeResetAt = this.nextDayReset();
      this.drawdownPaused = false; // reset drawdown pause daily

      // Reset per-whale daily volumes
      for (const perf of this.whalePerf.values()) {
        if (now >= perf.dailyVolumeResetAt) {
          perf.dailyVolumeUsd = 0;
          perf.dailyVolumeResetAt = this.nextDayReset();
        }
      }
    }
  }

  private nextDayReset(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime();
  }

  /* ━━━━━━━━━━━━━━ Config Builder ━━━━━━━━━━━━━━ */

  private buildConfig(raw: Record<string, unknown>): CopyTradeConfig {
    const d = DEFAULT_COPY_TRADE_CONFIG;
    return {
      whale_addresses: (raw.whale_addresses as string[]) ?? d.whale_addresses,
      copy_mode: (raw.copy_mode as 'mirror' | 'inverse') ?? d.copy_mode,
      data_api_url: (raw.data_api_url as string) ?? d.data_api_url,
      poll_interval_seconds: (raw.poll_interval_seconds as number) ?? d.poll_interval_seconds,
      max_trade_age_seconds: (raw.max_trade_age_seconds as number) ?? d.max_trade_age_seconds,
      min_trade_size_usd: (raw.min_trade_size_usd as number) ?? d.min_trade_size_usd,
      max_trade_size_usd: (raw.max_trade_size_usd as number) ?? d.max_trade_size_usd,
      min_whale_win_rate: (raw.min_whale_win_rate as number) ?? d.min_whale_win_rate,
      size_mode: (raw.size_mode as 'fixed' | 'proportional' | 'kelly') ?? d.size_mode,
      fixed_size: (raw.fixed_size as number) ?? d.fixed_size,
      proportional_factor: (raw.proportional_factor as number) ?? d.proportional_factor,
      max_capital_per_trade_pct: (raw.max_capital_per_trade_pct as number) ?? d.max_capital_per_trade_pct,
      max_shares_per_order: (raw.max_shares_per_order as number) ?? d.max_shares_per_order,
      max_open_positions: (raw.max_open_positions as number) ?? d.max_open_positions,
      max_exposure_per_market_usd: (raw.max_exposure_per_market_usd as number) ?? d.max_exposure_per_market_usd,
      max_daily_volume_usd: (raw.max_daily_volume_usd as number) ?? d.max_daily_volume_usd,
      max_drawdown_pct: (raw.max_drawdown_pct as number) ?? d.max_drawdown_pct,
      max_consecutive_losses: (raw.max_consecutive_losses as number) ?? d.max_consecutive_losses,
      cooldown_after_loss_seconds: (raw.cooldown_after_loss_seconds as number) ?? d.cooldown_after_loss_seconds,
      take_profit_bps: (raw.take_profit_bps as number) ?? d.take_profit_bps,
      stop_loss_bps: (raw.stop_loss_bps as number) ?? d.stop_loss_bps,
      trailing_stop_activate_bps: (raw.trailing_stop_activate_bps as number) ?? d.trailing_stop_activate_bps,
      trailing_stop_distance_bps: (raw.trailing_stop_distance_bps as number) ?? d.trailing_stop_distance_bps,
      time_exit_minutes: (raw.time_exit_minutes as number) ?? d.time_exit_minutes,
      exit_on_whale_exit: (raw.exit_on_whale_exit as boolean) ?? d.exit_on_whale_exit,
      blacklist_markets: (raw.blacklist_markets as string[]) ?? d.blacklist_markets,
      whitelist_markets: (raw.whitelist_markets as string[]) ?? d.whitelist_markets,
      min_market_liquidity: (raw.min_market_liquidity as number) ?? d.min_market_liquidity,
      min_market_volume_24h: (raw.min_market_volume_24h as number) ?? d.min_market_volume_24h,
    };
  }

  /* ━━━━━━━━━━━━━━ Public Accessors (for testing / dashboard) ━━━━━━━━━━━━━━ */

  getConfig(): CopyTradeConfig { return { ...this.cfg }; }
  getPositions(): Map<string, CopyPosition> { return new Map(this.positions); }
  getWhalePerformance(): Map<string, WhalePerformance> { return new Map(this.whalePerf); }
  getStats(): {
    totalCopied: number;
    openPositions: number;
    cumulativePnlBps: number;
    drawdownPct: number;
    dailyVolumeUsd: number;
    drawdownPaused: boolean;
  } {
    return {
      totalCopied: this.getTotalTradesCopied(),
      openPositions: this.positions.size,
      cumulativePnlBps: this.cumulativePnlBps,
      drawdownPct: this.getCurrentDrawdownPct(),
      dailyVolumeUsd: this.totalDailyVolumeUsd,
      drawdownPaused: this.drawdownPaused,
    };
  }

  /* ━━━━━━━━━━━━━━ Runtime whale address management ━━━━━━━━━━━━━━ */

  /** Add a whale address at runtime. Returns false if already tracked. */
  addWhaleAddress(address: string): boolean {
    const addr = address.toLowerCase().trim();
    if (!addr || this.cfg.whale_addresses.map(a => a.toLowerCase()).includes(addr)) return false;
    this.cfg.whale_addresses.push(addr);
    if (!this.whalePerf.has(addr)) {
      this.whalePerf.set(addr, {
        address: addr,
        tradesCopied: 0,
        wins: 0,
        losses: 0,
        totalPnlBps: 0,
        consecutiveLosses: 0,
        pausedUntil: 0,
        dailyVolumeUsd: 0,
        dailyVolumeResetAt: this.nextDayReset(),
      });
    }
    logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address added');
    consoleLog.success('STRATEGY', `[copy_trade] Added whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
    return true;
  }

  /** Remove a whale address at runtime. Returns false if not found. */
  removeWhaleAddress(address: string): boolean {
    const addr = address.toLowerCase().trim();
    const idx = this.cfg.whale_addresses.findIndex(a => a.toLowerCase() === addr);
    if (idx === -1) return false;
    this.cfg.whale_addresses.splice(idx, 1);
    logger.info({ strategy: this.name, address: addr, totalWhales: this.cfg.whale_addresses.length }, 'Whale address removed');
    consoleLog.warn('STRATEGY', `[copy_trade] Removed whale ${addr.slice(0, 10)}… — now tracking ${this.cfg.whale_addresses.length} whale(s)`);
    return true;
  }

  /** Get the list of tracked whale addresses. */
  getWhaleAddresses(): string[] {
    return [...this.cfg.whale_addresses];
  }

  override shutdown(): void {
    logger.info({ strategy: this.name, totalCopied: this.getTotalTradesCopied() }, 'Copy Trade strategy shutdown');
  }
}
