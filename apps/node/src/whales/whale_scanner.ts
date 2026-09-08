/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Continuous Liquid Market Scanner
   Scans ALL Polymarket markets with ≥$10 k liquidity, fetches trade
   history via the public data-api, profiles every address by volume /
   win-rate / ROI / hold-time / streaks, and surfaces the highest-quality
   whale wallets for auto-tracking.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type {
  ScannerConfig, ScannerState,
  ScannedWhaleProfile, ScannedMarketEntry,
  WhaleTrackingConfig, WhaleCluster,
  ApiEndpoint, ClusterSignal,
  WhaleNetworkEdge, WhaleNetworkGraph,
  CopySimResult, CopySimTrade,
  RegimeState, MarketRegime,
  ExchangeSource,
} from './whale_types';

/* ── Gamma market shape (subset) ── */
interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  volume24hr: number;
  liquidityNum: number;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
}

/* ── Internal trade shape (normalised from data-api) ── */
interface ClobTrade {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  match_time: string;
  owner: string;
  maker_address?: string;
  outcome?: string;
}

/* ── Internal aggregation structures ── */
interface AddressAgg {
  trades: number;
  volumeUsd: number;
  maxSingleTradeUsd: number;
  firstTradeTs: string;
  lastTradeTs: string;
  markets: Map<string, MarketAgg>;
}

interface MarketAgg {
  question: string;
  buys: TradeEntry[];
  sells: TradeEntry[];
  volumeUsd: number;
  trades: number;
  firstTradeTs: string;
  lastTradeTs: string;
  /** Maps asset (token) ID → current market price for unrealised PnL */
  currentPrices: Map<string, number>;
}

interface TradeEntry {
  price: number;
  size: number;
  notional: number;
  ts: string;
  assetId: string;
}

/* ── PnL result from FIFO matching ── */
interface PnlResult {
  pnl: number;
  closedCount: number;
  wins: number;
  largestWin: number;
  largestLoss: number;
  holdTimesMs: number[];
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  remainingOpenSize: number;
  /** Mark-to-market PnL on open positions (unrealised) */
  unrealisedPnl: number;
  /** Number of open position lots that are currently in profit */
  unrealisedWins: number;
  /** Total open lots (each FIFO buy that still has remaining size) */
  unrealisedPositions: number;
  /** Per-trade PnL array for Sharpe ratio calculation */
  perTradePnls: number[];
}

/* ── Constants ── */
const GAMMA_PAGE_SIZE = 100;
const MIN_LIQUIDITY_USD = 10_000;
const BATCH_PAUSE_MS = 500;           // ← reduced from 2 000 ms for faster cycling
const FETCH_TIMEOUT_MS = 6_000;       // ← tighter timeout (was 10 000)
const MARKET_CACHE_TTL_MS = 300_000;  // 5 min cache for Gamma market metadata

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Semaphore — limits concurrent async operations to N at a time.
   Used to parallelise market fetches without overwhelming the API.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) { }

  async acquire(): Promise<void> {
    if (this.current < this.max) { this.current++; return; }
    return new Promise<void>((resolve) => { this.queue.push(resolve); });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) { this.current++; next(); }
  }

  get pending(): number { return this.queue.length; }
  get active(): number { return this.current; }
}

/* ── Performance timer helper ── */
interface PerfMetrics {
  marketsPerSecond: number;
  tradesPerSecond: number;
  avgFetchLatencyMs: number;
  totalFetches: number;
  totalTradesFetched: number;
  parallelEfficiency: number;  // 0-1: actual vs theoretical throughput
}

/* ── TTL Cache for market metadata ── */
class MarketCache {
  private cache = new Map<string, { data: GammaMarket; expiresAt: number }>();

  set(market: GammaMarket): void {
    this.cache.set(market.id, { data: market, expiresAt: Date.now() + MARKET_CACHE_TTL_MS });
  }

  get(id: string): GammaMarket | null {
    const entry = this.cache.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.cache.delete(id); return null; }
    return entry.data;
  }

  has(id: string): boolean {
    const entry = this.cache.get(id);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.cache.delete(id); return false; }
    return true;
  }

  get size(): number { return this.cache.size; }

  prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(id);
    }
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Multi-API Pool — Round-robin / least-loaded / weighted-random rotation
   with independent per-endpoint rate limiters.  Multiplies effective
   throughput by N endpoints while respecting each provider's limits.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

class ApiPool {
  private endpoints: ApiEndpoint[] = [];
  private roundRobinIdx = 0;
  private strategy: 'round-robin' | 'least-loaded' | 'weighted-random';
  private healthCheckIntervalMs: number;
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    strategy: 'round-robin' | 'least-loaded' | 'weighted-random' = 'least-loaded',
    healthCheckIntervalMs = 120_000,
  ) {
    this.strategy = strategy;
    this.healthCheckIntervalMs = healthCheckIntervalMs;
  }

  /** Populate pool with built-in + user-configured endpoints */
  init(builtInUrls: { dataApi: string; gammaApi: string }, userEndpoints: { name: string; url: string; type: string; maxRequestsPerMinute: number; weight?: number; apiKey?: string; headers?: Record<string, string> }[]): void {
    /* Built-in data-api endpoints (primary + mirrors) */
    this.addEndpoint({
      name: 'data-api-primary',
      url: builtInUrls.dataApi,
      type: 'data-api',
      maxRequestsPerMinute: 60,
      weight: 10,
    });

    /* Built-in gamma-api for market discovery */
    this.addEndpoint({
      name: 'gamma-api-primary',
      url: builtInUrls.gammaApi,
      type: 'gamma-api',
      maxRequestsPerMinute: 60,
      weight: 10,
    });

    /* Additional data-api mirrors for throughput multiplication */
    const dataApiMirrors = [
      'https://data-api.polymarket.com',
      'https://data-api.polymarket.com',  // same host, counted separately for rotation
    ];
    for (let i = 0; i < dataApiMirrors.length; i++) {
      if (dataApiMirrors[i] !== builtInUrls.dataApi) {
        this.addEndpoint({
          name: `data-api-mirror-${i + 1}`,
          url: dataApiMirrors[i],
          type: 'data-api',
          maxRequestsPerMinute: 60,
          weight: 8,
        });
      }
    }

    /* User-configured custom endpoints */
    for (const ue of userEndpoints) {
      this.addEndpoint({
        name: ue.name,
        url: ue.url,
        type: ue.type as ApiEndpoint['type'],
        maxRequestsPerMinute: ue.maxRequestsPerMinute,
        weight: ue.weight ?? 5,
        apiKey: ue.apiKey,
        headers: ue.headers,
      });
    }

    /* Start health-check timer */
    this.healthTimer = setInterval(() => this.healthCheck(), this.healthCheckIntervalMs);

    logger.info({ totalEndpoints: this.endpoints.length, strategy: this.strategy }, 'ApiPool initialised');
  }

  private addEndpoint(cfg: { name: string; url: string; type: ApiEndpoint['type']; maxRequestsPerMinute: number; weight: number; apiKey?: string; headers?: Record<string, string> }): void {
    this.endpoints.push({
      name: cfg.name,
      url: cfg.url,
      type: cfg.type,
      maxRequestsPerMinute: cfg.maxRequestsPerMinute,
      healthy: true,
      lastSuccessAt: null,
      lastFailAt: null,
      consecutiveFailures: 0,
      maxConsecutiveFailures: 15,
      weight: cfg.weight,
      requestTimestamps: [],
      apiKey: cfg.apiKey,
      headers: cfg.headers,
    });
  }

  /** Select the best endpoint for a given type */
  pick(type: ApiEndpoint['type']): ApiEndpoint | null {
    const candidates = this.endpoints.filter((e) => e.type === type && e.healthy);
    if (candidates.length === 0) {
      /* Fallback: try unhealthy endpoints rather than giving up */
      const all = this.endpoints.filter((e) => e.type === type);
      if (all.length === 0) return null;
      return all[0];
    }

    switch (this.strategy) {
      case 'round-robin': {
        const idx = this.roundRobinIdx % candidates.length;
        this.roundRobinIdx++;
        return candidates[idx];
      }
      case 'least-loaded': {
        /* Pick the endpoint with the fewest recent requests */
        const cutoff = Date.now() - 60_000;
        let best = candidates[0];
        let bestLoad = Infinity;
        for (const ep of candidates) {
          ep.requestTimestamps = ep.requestTimestamps.filter((t) => t >= cutoff);
          const load = ep.requestTimestamps.length / ep.maxRequestsPerMinute;
          if (load < bestLoad) {
            bestLoad = load;
            best = ep;
          }
        }
        return best;
      }
      case 'weighted-random': {
        const totalWeight = candidates.reduce((sum, e) => sum + e.weight, 0);
        let r = Math.random() * totalWeight;
        for (const ep of candidates) {
          r -= ep.weight;
          if (r <= 0) return ep;
        }
        return candidates[candidates.length - 1];
      }
      default:
        return candidates[0];
    }
  }

  /** Record a successful request */
  recordSuccess(ep: ApiEndpoint): void {
    ep.lastSuccessAt = Date.now();
    ep.consecutiveFailures = 0;
    ep.healthy = true;
  }

  /** Record a failed request */
  recordFailure(ep: ApiEndpoint): void {
    ep.lastFailAt = Date.now();
    ep.consecutiveFailures++;
    if (ep.consecutiveFailures >= ep.maxConsecutiveFailures) {
      ep.healthy = false;
      logger.warn({ endpoint: ep.name, failures: ep.consecutiveFailures }, 'ApiPool: endpoint marked unhealthy');
    }
  }

  /** Wait until this endpoint has capacity within its rate limit */
  async waitForCapacity(ep: ApiEndpoint): Promise<void> {
    const cutoff = Date.now() - 60_000;
    ep.requestTimestamps = ep.requestTimestamps.filter((t) => t >= cutoff);
    if (ep.requestTimestamps.length >= ep.maxRequestsPerMinute) {
      const oldest = ep.requestTimestamps[0];
      const waitMs = oldest + 60_000 - Date.now() + 50;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    ep.requestTimestamps.push(Date.now());
  }

  /** Re-enable unhealthy endpoints periodically */
  private healthCheck(): void {
    for (const ep of this.endpoints) {
      if (!ep.healthy && ep.lastFailAt) {
        const elapsed = Date.now() - ep.lastFailAt;
        if (elapsed > this.healthCheckIntervalMs) {
          ep.healthy = true;
          ep.consecutiveFailures = 0;
          logger.info({ endpoint: ep.name }, 'ApiPool: endpoint re-enabled');
        }
      }
    }
  }

  /** Get pool status for API response */
  getStatus(): { total: number; healthy: number; endpoints: { name: string; type: string; healthy: boolean; recentRequests: number; consecutiveFailures: number }[] } {
    return {
      total: this.endpoints.length,
      healthy: this.endpoints.filter((e) => e.healthy).length,
      endpoints: this.endpoints.map((e) => ({
        name: e.name,
        type: e.type,
        healthy: e.healthy,
        recentRequests: e.requestTimestamps.filter((t) => t >= Date.now() - 60_000).length,
        consecutiveFailures: e.consecutiveFailures,
      })),
    };
  }

  /** Aggregate effective requests per minute across all healthy endpoints of a type */
  effectiveRpm(type: ApiEndpoint['type']): number {
    return this.endpoints
      .filter((e) => e.type === type && e.healthy)
      .reduce((sum, e) => sum + e.maxRequestsPerMinute, 0);
  }

  stop(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

export class WhaleScanner {
  private db: WhaleDB;
  private config: WhaleTrackingConfig;
  private scannerConfig: ScannerConfig;
  private gammaApi: string;
  private clobApi: string;
  private dataApi: string;
  private requestTimestamps: number[] = [];
  private scanStartedAt: number | null = null;

  /* ── Multi-API pool ── */
  private apiPool: ApiPool;

  /* ── Re-entrancy guard (separate from display status) ── */
  private batchInProgress = false;

  /* ── Cumulative address aggregation across all batches ── */
  private globalAgg = new Map<string, AddressAgg>();
  private scannedMarketIds = new Set<string>();
  private seenTradeHashes = new Set<string>();

  /* ── Cross-referencing: addresses already deep-scanned ── */
  private crossReferencedAddresses = new Set<string>();

  /* ── Whale clusters detected this scan ── */
  private latestClusters: WhaleCluster[] = [];

  /* ── Big-trade discoveries (address → biggest single trade) ── */
  private bigTradeAddresses = new Map<string, number>();

  /* ── Fast-scan state ── */
  private fastScanTimer: ReturnType<typeof setInterval> | null = null;
  private hotMarkets: GammaMarket[] = [];

  /* ── Cluster signals ── */
  private clusterSignals: ClusterSignal[] = [];

  /* ── Network graph ── */
  private networkGraph: WhaleNetworkGraph | null = null;

  /* ── Copy-trade simulation results ── */
  private copySimResults = new Map<string, CopySimResult>();

  /* ── Regime state ── */
  private regimeState: RegimeState | null = null;

  /* ── Historical backfill tracking ── */
  private backfillComplete = false;

  /* ── Wallet balances (address → USDC balance) ── */
  private walletBalances = new Map<string, number>();

  /* ── Concurrency control ── */
  private semaphore!: Semaphore;

  /* ── Market metadata cache (avoids re-fetching from Gamma) ── */
  private marketCache = new MarketCache();

  /* ── Performance counters (reset each batch) ── */
  private perfFetchCount = 0;
  private perfFetchLatencySum = 0;
  private perfTradesFetched = 0;

  /* ── Public state ── */
  private state: ScannerState = {
    status: 'idle',
    enabled: false,
    lastScanAt: null,
    nextScanAt: null,
    marketsScanned: 0,
    totalMarketsDiscovered: 0,
    addressesAnalysed: 0,
    profilesFound: 0,
    qualifiedCount: 0,
    whalesPromoted: 0,
    currentMarket: null,
    scanProgress: 0,
    lastError: null,
    scanDurationMs: null,
    totalScanTimeMs: 0,
    totalScansCompleted: 0,
    batchNumber: 0,
    marketsInCurrentBatch: 0,
  };

  private latestProfiles: ScannedWhaleProfile[] = [];

  constructor(
    db: WhaleDB,
    config: WhaleTrackingConfig,
    gammaApi: string,
    clobApi: string,
  ) {
    this.db = db;
    this.config = config;
    this.scannerConfig = config.scanner;
    this.gammaApi = gammaApi;
    this.clobApi = clobApi;
    this.dataApi = 'https://data-api.polymarket.com';

    /* Initialise multi-API pool */
    this.apiPool = new ApiPool(
      this.scannerConfig.apiPool.selectionStrategy,
      this.scannerConfig.apiPool.healthCheckIntervalMs,
    );
    this.apiPool.init(
      { dataApi: this.dataApi, gammaApi: this.gammaApi },
      this.scannerConfig.apiPool.endpoints,
    );

    /* Initialise concurrency semaphore: controls how many parallel fetches */
    this.semaphore = new Semaphore(this.scannerConfig.parallelFetchBatch || 8);
  }

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  start(): void {
    if (this.state.enabled) return;
    this.state.enabled = true;
    this.state.status = 'scanning';
    this.scanStartedAt = Date.now();
    logger.info('WhaleScanner started — continuous mode');

    /* Start fast-scan timer if enabled */
    if (this.scannerConfig.fastScan.enabled) {
      this.startFastScan();
    }

    void this.runContinuousLoop();
  }

  stop(): void {
    this.state.enabled = false;
    this.state.status = 'idle';
    this.state.currentMarket = null;
    this.state.scanProgress = 0;
    this.state.nextScanAt = null;
    if (this.scanStartedAt) {
      this.state.totalScanTimeMs += Date.now() - this.scanStartedAt;
      this.scanStartedAt = null;
    }
    this.stopFastScan();
    this.apiPool.stop();
    logger.info('WhaleScanner stopped');
  }

  toggle(): boolean {
    if (this.state.enabled) { this.stop(); } else { this.start(); }
    return this.state.enabled;
  }

  isEnabled(): boolean { return this.state.enabled; }

  getState(): ScannerState {
    const st = { ...this.state };
    if (this.scanStartedAt) {
      st.totalScanTimeMs = this.state.totalScanTimeMs + (Date.now() - this.scanStartedAt);
    }
    st.scannerConfig = {
      parallelFetchBatch: this.scannerConfig.parallelFetchBatch,
      maxRequestsPerMinute: this.apiPool.effectiveRpm('gamma-api') + this.apiPool.effectiveRpm('data-api'),
      marketsPerScan: this.scannerConfig.marketsPerScan,
      minVolume: this.scannerConfig.minMarketVolume24hUsd,
      minLiquidity: this.scannerConfig.minMarketLiquidityUsd,
    };
    return st;
  }

  getResults(): ScannedWhaleProfile[] { return this.latestProfiles; }

  getClusters(): WhaleCluster[] { return this.latestClusters; }

  getClusterSignals(): ClusterSignal[] { return this.clusterSignals; }

  getNetworkGraph(): WhaleNetworkGraph | null { return this.networkGraph; }

  getCopySimResults(): CopySimResult[] { return [...this.copySimResults.values()]; }

  getCopySimResult(address: string): CopySimResult | undefined { return this.copySimResults.get(address.toLowerCase()); }

  getRegimeState(): RegimeState | null { return this.regimeState; }

  getApiPoolStatus(): ReturnType<ApiPool['getStatus']> { return this.apiPool.getStatus(); }

  getWalletBalance(address: string): number | undefined { return this.walletBalances.get(address.toLowerCase()); }

  getProfile(address: string): ScannedWhaleProfile | undefined {
    const norm = address.toLowerCase();
    return this.latestProfiles.find((p) => p.address === norm);
  }

  async triggerScan(): Promise<ScannedWhaleProfile[]> {
    await this.runScanBatch();
    return this.latestProfiles;
  }

  /* ━━━━━━━━━━━━━━ Continuous Loop ━━━━━━━━━━━━━━ */

  private async runContinuousLoop(): Promise<void> {
    /* ── Historical backfill on first start ── */
    if (!this.backfillComplete && this.scannerConfig.backfillDays > 0) {
      try {
        await this.runHistoricalBackfill();
      } catch (err) {
        logger.error({ err }, 'Historical backfill failed — continuing with live scan');
      }
      this.backfillComplete = true;
    }

    while (this.state.enabled) {
      try {
        await this.runScanBatch();

        /* ── Post-batch enrichment ── */
        if (this.scannerConfig.networkGraphEnabled) {
          this.buildNetworkGraph();
        }
        if (this.scannerConfig.copySimEnabled) {
          this.runCopySimulations();
        }
        if (this.scannerConfig.regimeAdaptiveEnabled) {
          this.evaluateRegime();
        }
        /* Wallet balance lookups for top whales */
        if (this.scannerConfig.polygonRpcUrl) {
          await this.lookupTopWalletBalances();
        }
        /* Multi-exchange cross-scan */
        for (const src of this.scannerConfig.exchangeSources) {
          if (src.enabled && src.exchange !== 'polymarket') {
            await this.scanExternalExchange(src);
          }
        }
      } catch (err) {
        if (!this.state.enabled) break;
        this.state.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'Scanner batch failed — retrying in 10s');
      }
      if (this.state.enabled) {
        await this.sleep(BATCH_PAUSE_MS);
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Single Scan Batch ━━━━━━━━━━━━━━ */

  private async runScanBatch(): Promise<void> {
    if (this.batchInProgress) return;
    this.batchInProgress = true;
    this.state.status = 'scanning';
    this.state.scanProgress = 0;
    this.state.currentMarket = null;
    this.state.lastError = null;
    this.state.marketsInCurrentBatch = 0;
    this.state.batchNumber++;
    const batchStart = Date.now();

    /* Reset perf counters */
    this.perfFetchCount = 0;
    this.perfFetchLatencySum = 0;
    this.perfTradesFetched = 0;

    /* How often to rebuild profiles so the dashboard shows live data */
    const PROFILE_REBUILD_INTERVAL = 25;
    let marketsProcessedThisBatch = 0;

    try {
      /* ── Page-by-page scan: discover a page of markets and immediately
           process them IN PARALLEL before moving to the next page.
           Uses a Semaphore to cap concurrency at parallelFetchBatch. ── */

      let offset = 0;
      let hasMore = true;
      let totalQualifying = 0;

      while (hasMore && this.state.status === 'scanning') {
        /* ── Phase 1: Fetch one page of liquid markets from Gamma ── */
        this.state.currentMarket = `Discovering markets (page ${Math.floor(offset / GAMMA_PAGE_SIZE) + 1})…`;
        const url = `${this.gammaApi}/markets?active=true&closed=false&limit=${GAMMA_PAGE_SIZE}&offset=${offset}&order=liquidityNum&ascending=false`;

        await this.rateLimitWait();
        const res = await this.fetchWithRetry(url);
        if (!res) break;

        const page: GammaMarket[] = await res.json() as GammaMarket[];
        if (page.length === 0) { hasMore = false; break; }

        /* Cache market metadata for fast lookups */
        for (const m of page) this.marketCache.set(m);

        const qualifying = page.filter((m) =>
          m.acceptingOrders &&
          m.conditionId &&
          Number(m.liquidityNum) >= MIN_LIQUIDITY_USD &&
          Number(m.volume24hr) >= this.scannerConfig.minMarketVolume24hUsd,
        );
        totalQualifying += qualifying.length;
        this.state.totalMarketsDiscovered = totalQualifying;

        const lastLiq = Number(page[page.length - 1].liquidityNum);
        if (lastLiq < MIN_LIQUIDITY_USD || page.length < GAMMA_PAGE_SIZE) {
          hasMore = false;
        } else {
          offset += GAMMA_PAGE_SIZE;
        }

        /* ── Phase 2: PARALLEL scan of new markets from this page ── */
        const newMarkets = qualifying.filter((m) => !this.scannedMarketIds.has(m.id));
        if (newMarkets.length === 0) continue;

        this.state.marketsInCurrentBatch += newMarkets.length;

        /* Mark all as scanned immediately to prevent duplicate processing */
        for (const m of newMarkets) this.scannedMarketIds.add(m.id);

        /* Process markets in parallel using semaphore for concurrency control */
        const concurrency = this.scannerConfig.parallelFetchBatch || 8;
        this.state.currentMarket = `Scanning ${newMarkets.length} markets (${concurrency}x parallel)…`;

        /* Track completed count for live progress updates */
        let completedInPage = 0;
        let errorsInPage = 0;
        let lastPageError: unknown = null;

        const processMarket = async (market: GammaMarket): Promise<number> => {
          if (this.state.status !== 'scanning') return 0;
          await this.semaphore.acquire();
          try {
            const trades = await this.fetchMarketTrades(market.conditionId);
            const currentPrices = this.buildCurrentPriceMap(market);
            this.aggregateTrades(this.globalAgg, trades, market.conditionId, market.question, currentPrices);

            /* ── Live progress: update state as each market completes ── */
            completedInPage++;
            marketsProcessedThisBatch++;
            this.state.marketsScanned = marketsProcessedThisBatch;
            this.state.scanProgress = parseFloat(
              ((marketsProcessedThisBatch / Math.max(totalQualifying, 1)) * 90).toFixed(1),
            );
            this.state.currentMarket = `Scanning… ${marketsProcessedThisBatch}/${totalQualifying} markets (${concurrency}x parallel)`;
            this.perfTradesFetched += trades.length;

            return trades.length;
          } catch (err) {
            errorsInPage++;
            lastPageError = err;
            throw err;
          } finally {
            this.semaphore.release();
          }
        };

        /* Fire all market fetches concurrently (semaphore limits actual parallelism) */
        const results = await Promise.allSettled(newMarkets.map((m) => processMarket(m)));

        /* Re-count errors from allSettled (processMarket already incremented marketsProcessedThisBatch on success) */
        let batchErrors = 0;
        let lastError: unknown = null;
        for (const r of results) {
          if (r.status === 'rejected') { batchErrors++; lastError = r.reason; }
        }

        /* If every single market in this page failed, propagate the error */
        if (batchErrors > 0 && batchErrors === results.length) {
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        }

        /* ── Final stat update after page completes ── */
        this.state.marketsScanned = marketsProcessedThisBatch;
        this.state.scanProgress = parseFloat(
          ((marketsProcessedThisBatch / Math.max(totalQualifying, 1)) * 90).toFixed(1),
        );

        /* ── Periodically rebuild profiles so results appear live ── */
        if (marketsProcessedThisBatch >= PROFILE_REBUILD_INTERVAL &&
          marketsProcessedThisBatch % PROFILE_REBUILD_INTERVAL < newMarkets.length) {
          this.rebuildProfiles();
          const elapsed = (Date.now() - batchStart) / 1000;
          logger.info({
            batch: this.state.batchNumber,
            marketsProcessed: marketsProcessedThisBatch,
            totalDiscovered: totalQualifying,
            profiles: this.latestProfiles.length,
            qualified: this.state.qualifiedCount,
            marketsPerSec: (marketsProcessedThisBatch / elapsed).toFixed(1),
          }, 'Scanner: incremental profile rebuild');
        }
      }

      /* ── All pages exhausted or scanner stopped ── */

      if (marketsProcessedThisBatch === 0 && totalQualifying === 0) {
        this.state.status = this.state.enabled ? 'scanning' : 'idle';
        this.state.scanDurationMs = Date.now() - batchStart;
        this.batchInProgress = false;
        logger.warn('Scanner: no liquid markets found');
        return;
      }

      /* Check if we've done a full sweep (all qualifying markets already scanned) */
      if (marketsProcessedThisBatch === 0 && totalQualifying > 0) {
        this.rebuildProfiles();
        this.state.status = this.state.enabled ? 'scanning' : 'idle';
        this.state.scanDurationMs = Date.now() - batchStart;
        this.state.lastScanAt = new Date().toISOString();
        this.state.totalScansCompleted++;
        this.scannedMarketIds.clear();
        this.seenTradeHashes.clear();
        this.crossReferencedAddresses.clear();
        this.latestClusters = [];
        this.bigTradeAddresses.clear();
        this.state.marketsInCurrentBatch = 0;
        this.batchInProgress = false;
        this.pruneUnboundedState();
        logger.info({ totalProfiles: this.latestProfiles.length, batch: this.state.batchNumber }, 'Scanner: full sweep done — resetting for fresh data');
        return;
      }

      this.state.marketsScanned = this.scannedMarketIds.size;
      this.state.scanProgress = 95;

      this.rebuildProfiles();

      /* ── Big-trade spike detection ── */
      this.detectBigTrades();

      /* ── Cross-referencing: deep-scan top whales across all markets ── */
      if (this.scannerConfig.crossRefEnabled) {
        await this.crossReferenceTopWhales();
        this.rebuildProfiles();
      }

      /* ── Whale cluster detection ── */
      if (this.scannerConfig.clusterDetectionEnabled) {
        this.detectClusters();
        this.generateClusterSignals();
      }

      this.state.scanProgress = 100;
      this.state.lastScanAt = new Date().toISOString();
      this.state.scanDurationMs = Date.now() - batchStart;
      this.state.totalScansCompleted++;

      if (this.scannerConfig.autoPromoteEnabled) {
        const promoted = this.autoPromoteTopWhales(this.latestProfiles);
        this.state.whalesPromoted += promoted;
      }

      this.state.status = this.state.enabled ? 'scanning' : 'idle';
      this.state.currentMarket = null;
      this.batchInProgress = false;

      /* ── Compute performance metrics ── */
      const batchDuration = Date.now() - batchStart;
      const elapsedSec = Math.max(batchDuration / 1000, 0.001);
      const concurrency = this.scannerConfig.parallelFetchBatch || 8;
      this.state.perf = {
        marketsPerSecond: Math.round((marketsProcessedThisBatch / elapsedSec) * 100) / 100,
        tradesPerSecond: Math.round((this.perfTradesFetched / elapsedSec) * 100) / 100,
        avgFetchLatencyMs: this.perfFetchCount > 0
          ? Math.round(this.perfFetchLatencySum / this.perfFetchCount)
          : 0,
        totalFetches: this.perfFetchCount,
        totalTradesFetched: this.perfTradesFetched,
        parallelEfficiency: this.perfFetchCount > 0
          ? Math.min(1, Math.round((marketsProcessedThisBatch / (elapsedSec * concurrency)) * 100) / 100)
          : 0,
        concurrentWorkers: concurrency,
      };

      logger.info({
        batch: this.state.batchNumber,
        newMarkets: marketsProcessedThisBatch,
        totalMarkets: this.scannedMarketIds.size,
        addressesProfiled: this.latestProfiles.length,
        qualifiedWhales: this.state.qualifiedCount,
        durationMs: this.state.scanDurationMs,
        marketsPerSec: this.state.perf.marketsPerSecond,
        tradesPerSec: this.state.perf.tradesPerSecond,
        avgLatencyMs: this.state.perf.avgFetchLatencyMs,
        concurrency,
      }, 'Scanner batch complete');
    } catch (err) {
      this.state.status = this.state.enabled ? 'scanning' : 'error';
      this.state.lastError = err instanceof Error ? err.message : String(err);
      this.state.scanDurationMs = Date.now() - batchStart;
      this.state.currentMarket = null;
      this.batchInProgress = false;
      logger.error({ err }, 'Scanner batch failed');
    }
  }

  private rebuildProfiles(): void {
    const profiles = this.profileAddresses(this.globalAgg);
    this.latestProfiles = profiles;
    this.state.addressesAnalysed = profiles.length;
    this.state.profilesFound = profiles.length;
    this.state.qualifiedCount = profiles.filter(
      (p) => p.compositeScore >= this.scannerConfig.autoPromoteMinScore,
    ).length;
  }

  /* ━━━━━━━━━━━━━━ Step 1: Fetch ALL liquid markets (paginated) ━━━━━━━━━━━━━━ */

  private async fetchAllLiquidMarkets(): Promise<GammaMarket[]> {
    const allMarkets: GammaMarket[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore && this.state.status === 'scanning') {
      const url = `${this.gammaApi}/markets?active=true&closed=false&limit=${GAMMA_PAGE_SIZE}&offset=${offset}&order=liquidityNum&ascending=false`;

      await this.rateLimitWait();
      const res = await this.fetchWithRetry(url);
      if (!res) break;

      const page: GammaMarket[] = await res.json() as GammaMarket[];
      if (page.length === 0) { hasMore = false; break; }

      const qualifying = page.filter((m) =>
        m.acceptingOrders &&
        m.conditionId &&
        Number(m.liquidityNum) >= MIN_LIQUIDITY_USD &&
        Number(m.volume24hr) >= this.scannerConfig.minMarketVolume24hUsd,
      );

      allMarkets.push(...qualifying);

      const lastLiq = Number(page[page.length - 1].liquidityNum);
      if (lastLiq < MIN_LIQUIDITY_USD || page.length < GAMMA_PAGE_SIZE) {
        hasMore = false;
      } else {
        offset += GAMMA_PAGE_SIZE;
      }
    }

    logger.info({
      totalQualifying: allMarkets.length,
      alreadyScanned: this.scannedMarketIds.size,
      newMarkets: allMarkets.filter((m) => !this.scannedMarketIds.has(m.id)).length,
    }, 'Scanner: fetchAllLiquidMarkets');

    return allMarkets;
  }

  /* ━━━━━━━━━━━━━━ Step 1b: Build asset→currentPrice map ━━━━━━━━━━━━━━ */

  /**
   * Parse `clobTokenIds` and `outcomePrices` from a Gamma market snapshot
   * into a Map<assetId, currentPrice>.
   *
   * Gamma stores these as JSON arrays:
   *   clobTokenIds:  '["1234...","5678..."]'
   *   outcomePrices: '["0.65","0.35"]'
   */
  private buildCurrentPriceMap(market: GammaMarket): Map<string, number> {
    const prices = new Map<string, number>();
    try {
      const tokenIds: string[] = JSON.parse(market.clobTokenIds || '[]');
      const pricesArr: string[] = JSON.parse(market.outcomePrices || '[]');
      for (let i = 0; i < tokenIds.length && i < pricesArr.length; i++) {
        const p = parseFloat(pricesArr[i]);
        if (!isNaN(p) && tokenIds[i]) {
          prices.set(tokenIds[i], p);
        }
      }
    } catch {
      /* Gamma format changed or fields missing — non-fatal */
    }
    return prices;
  }

  /* ━━━━━━━━━━━━━━ Step 2: Fetch trades per market (PARALLEL pages) ━━━━━━━━━━━━━━ */

  /**
   * Fetch trade history for a single market.
   * Pages 0..tradePageDepth are fired concurrently via Promise.allSettled.
   * If any page returns empty or fails, its data is simply skipped.
   * This is 3-5× faster than the old sequential page loop.
   */
  private async fetchMarketTrades(conditionId: string): Promise<ClobTrade[]> {
    const limit = this.scannerConfig.tradesPerMarket;
    const maxPages = this.scannerConfig.tradePageDepth;

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

    const fetchPage = async (pageIdx: number): Promise<ClobTrade[]> => {
      const offset = pageIdx * limit;
      const ep = this.apiPool.pick('data-api');
      const baseUrl = ep ? ep.url : this.dataApi;
      const url = `${baseUrl}/trades?market=${conditionId}&limit=${limit}&offset=${offset}`;

      if (ep) {
        await this.apiPool.waitForCapacity(ep);
      } else {
        await this.rateLimitWait();
      }

      const t0 = Date.now();
      const res = await this.fetchWithRetry(url);
      this.perfFetchCount++;
      this.perfFetchLatencySum += Date.now() - t0;

      if (res) {
        if (ep) this.apiPool.recordSuccess(ep);
      } else {
        if (ep) this.apiPool.recordFailure(ep);
        return [];
      }

      const raw: DataApiTrade[] = await res.json() as DataApiTrade[];
      if (!Array.isArray(raw) || raw.length === 0) return [];

      return raw
        .filter((t) => t.proxyWallet && t.side && t.size != null && t.price != null)
        .map((t) => ({
          id: t.transactionHash ?? '',
          market: conditionId,
          asset_id: t.asset ?? '',
          side: (t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          size: String(t.size),
          price: String(t.price),
          match_time: t.timestamp
            ? new Date(t.timestamp * 1000).toISOString()
            : new Date().toISOString(),
          owner: t.proxyWallet ?? '',
          outcome: t.outcome,
        }));
    };

    /* Fire all pages concurrently */
    const pagePromises = Array.from({ length: maxPages }, (_, i) => fetchPage(i));
    const results = await Promise.allSettled(pagePromises);

    const allTrades: ClobTrade[] = [];
    let rejectedCount = 0;
    let firstRejection: unknown = null;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allTrades.push(...r.value);
      } else if (r.status === 'rejected') {
        rejectedCount++;
        if (!firstRejection) firstRejection = r.reason;
      }
    }

    /* If every single page rejected (not just empty), propagate the error */
    if (rejectedCount === results.length && rejectedCount > 0) {
      throw firstRejection instanceof Error ? firstRejection : new Error(String(firstRejection));
    }

    this.perfTradesFetched += allTrades.length;
    return allTrades;
  }

  /* ━━━━━━━━━━━━━━ Step 2b: Aggregate trades by address ━━━━━━━━━━━━━━ */

  private aggregateTrades(
    global: Map<string, AddressAgg>,
    trades: ClobTrade[],
    marketId: string,
    question: string,
    currentPrices?: Map<string, number>,
  ): void {
    for (const t of trades) {
      /* ── Deduplicate trades by transaction hash ── */
      if (t.id && this.seenTradeHashes.has(t.id)) continue;
      if (t.id) this.seenTradeHashes.add(t.id);

      const addresses = [t.owner];
      if (t.maker_address) addresses.push(t.maker_address);

      const price = parseFloat(t.price);
      const size = parseFloat(t.size);
      const notional = price * size;

      for (const rawAddr of addresses) {
        if (!rawAddr) continue;
        const addr = rawAddr.toLowerCase();

        if (!global.has(addr)) {
          global.set(addr, {
            trades: 0,
            volumeUsd: 0,
            maxSingleTradeUsd: 0,
            firstTradeTs: t.match_time,
            lastTradeTs: t.match_time,
            markets: new Map(),
          });
        }
        const agg = global.get(addr)!;
        agg.trades++;
        agg.volumeUsd += notional;
        agg.maxSingleTradeUsd = Math.max(agg.maxSingleTradeUsd, notional);
        if (t.match_time < agg.firstTradeTs) agg.firstTradeTs = t.match_time;
        if (t.match_time > agg.lastTradeTs) agg.lastTradeTs = t.match_time;

        if (!agg.markets.has(marketId)) {
          agg.markets.set(marketId, {
            question,
            buys: [],
            sells: [],
            volumeUsd: 0,
            trades: 0,
            firstTradeTs: t.match_time,
            lastTradeTs: t.match_time,
            currentPrices: currentPrices ?? new Map(),
          });
        }
        const mAgg = agg.markets.get(marketId)!;
        /* Update current prices if provided (latest snapshot wins) */
        if (currentPrices && currentPrices.size > 0) {
          mAgg.currentPrices = currentPrices;
        }
        mAgg.volumeUsd += notional;
        mAgg.trades++;
        if (t.match_time < mAgg.firstTradeTs) mAgg.firstTradeTs = t.match_time;
        if (t.match_time > mAgg.lastTradeTs) mAgg.lastTradeTs = t.match_time;

        const entry: TradeEntry = { price, size, notional, ts: t.match_time, assetId: t.asset_id };
        if (t.side === 'BUY') mAgg.buys.push(entry);
        else mAgg.sells.push(entry);
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Step 3: Profile each address ━━━━━━━━━━━━━━ */

  private profileAddresses(global: Map<string, AddressAgg>): ScannedWhaleProfile[] {
    const existing = this.db.listWhales({ limit: 10_000 });
    const trackedAddrs = new Set(existing.whales.map((w) => w.address.toLowerCase()));
    const candidateAddrs = new Set(
      this.db.listCandidates({ limit: 10_000 }).map((c) => c.address.toLowerCase()),
    );

    const profiles: ScannedWhaleProfile[] = [];

    for (const [addr, agg] of global) {
      if (agg.volumeUsd < this.scannerConfig.minAddressVolumeUsd) continue;
      if (agg.trades < this.scannerConfig.minAddressTrades) continue;

      let totalEstPnl = 0;
      let totalClosedTrades = 0;
      let totalWins = 0;
      let totalLargestWin = 0;
      let totalLargestLoss = 0;
      let longestWinStreak = 0;
      let longestLossStreak = 0;
      let currentStreak = 0;
      let totalUnrealisedPnl = 0;
      let totalUnrealisedWins = 0;
      let totalUnrealisedPositions = 0;
      const allHoldTimesMs: number[] = [];
      const allPerTradePnls: number[] = [];
      const marketBreakdown: ScannedMarketEntry[] = [];

      for (const [mktId, mAgg] of agg.markets) {
        const pnlResult = this.estimateMarketPnl(mAgg);
        totalEstPnl += pnlResult.pnl;
        totalClosedTrades += pnlResult.closedCount;
        totalWins += pnlResult.wins;
        totalLargestWin = Math.max(totalLargestWin, pnlResult.largestWin);
        totalLargestLoss = Math.min(totalLargestLoss, pnlResult.largestLoss);
        longestWinStreak = Math.max(longestWinStreak, pnlResult.longestWinStreak);
        longestLossStreak = Math.max(longestLossStreak, pnlResult.longestLossStreak);
        currentStreak = pnlResult.currentStreak;
        allHoldTimesMs.push(...pnlResult.holdTimesMs);
        allPerTradePnls.push(...pnlResult.perTradePnls);
        totalUnrealisedPnl += pnlResult.unrealisedPnl;
        totalUnrealisedWins += pnlResult.unrealisedWins;
        totalUnrealisedPositions += pnlResult.unrealisedPositions;

        const netBuyVol = mAgg.buys.reduce((s, b) => s + b.notional, 0);
        const netSellVol = mAgg.sells.reduce((s, b) => s + b.notional, 0);
        const netSide: 'BUY' | 'SELL' | 'NEUTRAL' =
          netBuyVol > netSellVol * 1.2 ? 'BUY' :
            netSellVol > netBuyVol * 1.2 ? 'SELL' : 'NEUTRAL';

        const mktHoldHrs = pnlResult.holdTimesMs.length > 0
          ? pnlResult.holdTimesMs.reduce((a, b) => a + b, 0) / pnlResult.holdTimesMs.length / 3_600_000
          : 0;

        marketBreakdown.push({
          marketId: mktId,
          question: mAgg.question,
          volumeUsd: mAgg.volumeUsd,
          trades: mAgg.trades,
          netSide,
          estimatedPnlUsd: pnlResult.pnl + pnlResult.unrealisedPnl,
          avgEntryPrice: pnlResult.avgEntryPrice,
          avgExitPrice: pnlResult.avgExitPrice,
          avgHoldTimeHrs: Math.round(mktHoldHrs * 100) / 100,
          openPositionSize: Math.round(pnlResult.remainingOpenSize * 1000) / 1000,
          positionStatus: pnlResult.remainingOpenSize > 0.01 ? 'active' : 'closed',
          firstTradeTs: mAgg.firstTradeTs,
          lastTradeTs: mAgg.lastTradeTs,
        });
      }

      const estimatedWinRate = (totalClosedTrades + totalUnrealisedPositions) > 0
        ? (totalWins + totalUnrealisedWins) / (totalClosedTrades + totalUnrealisedPositions) : 0;
      const combinedPnl = totalEstPnl + totalUnrealisedPnl;
      const estimatedRoi = agg.volumeUsd > 0 ? combinedPnl / agg.volumeUsd : 0;

      const avgHoldMs = allHoldTimesMs.length > 0
        ? allHoldTimesMs.reduce((a, b) => a + b, 0) / allHoldTimesMs.length : 0;
      const sortedHold = [...allHoldTimesMs].sort((a, b) => a - b);
      const medianHoldMs = sortedHold.length > 0
        ? sortedHold[Math.floor(sortedHold.length / 2)] : 0;

      const firstTs = new Date(agg.firstTradeTs).getTime();
      const lastTs = new Date(agg.lastTradeTs).getTime();
      const tradingSpanDays = Math.max(0, (lastTs - firstTs) / 86_400_000);

      const ageMs = Date.now() - lastTs;
      const ageDays = ageMs / 86_400_000;
      const recencyMultiplier = Math.max(0.1, 1 - (ageDays / 7));
      const activityScore = Math.min(100, (agg.volumeUsd / 1000) * recencyMultiplier);

      /* ── Confidence score: more trades / markets → higher confidence ── */
      const sampleSize = totalClosedTrades + totalUnrealisedPositions;
      const confidenceScore = Math.min(1, (1 - 1 / Math.max(sampleSize, 1)) * Math.min(1, agg.markets.size / 3));

      /* ── Sharpe ratio: mean PnL per closed trade / stddev ── */
      let sharpeRatio = 0;
      const maxDrawdownPct = this.computeMaxDrawdown(marketBreakdown);
      if (totalClosedTrades > 1 && allPerTradePnls.length > 1) {
        const meanPnl = allPerTradePnls.reduce((a, b) => a + b, 0) / allPerTradePnls.length;
        const variance = allPerTradePnls.reduce((a, b) => a + (b - meanPnl) ** 2, 0) / allPerTradePnls.length;
        const stddev = Math.sqrt(variance);
        sharpeRatio = stddev > 0 ? meanPnl / stddev : 0;
      }

      /* ── Improved composite score (penalise drawdown, reward consistency) ── */
      const volScore = Math.min(100, Math.log10(Math.max(agg.volumeUsd, 1)) / Math.log10(1_000_000) * 100);
      const wrScore = estimatedWinRate * 100;
      const roiScore = Math.min(100, Math.max(0, (estimatedRoi + 0.1) / 0.6 * 100));
      const sharpeScore = Math.min(100, Math.max(0, sharpeRatio * 40));
      const drawdownPenalty = Math.min(30, maxDrawdownPct * 100);

      const rawComposite =
        volScore * 0.15 +         // reduced from 0.25 — stop rewarding volume-only
        wrScore * 0.25 +          // slightly reduced
        roiScore * 0.20 +         // slightly reduced
        sharpeScore * 0.15 +      // NEW: reward risk-adjusted returns
        Math.min(100, activityScore) * 0.15 + // recency
        (confidenceScore * 10);   // small bonus for high-confidence data

      const compositeScore = Math.round(Math.min(100, Math.max(0, rawComposite - drawdownPenalty)));

      const suggestedTags = this.inferTags(agg, estimatedWinRate, estimatedRoi, avgHoldMs);

      profiles.push({
        address: addr,
        totalVolumeUsd: Math.round(agg.volumeUsd * 100) / 100,
        totalTrades: agg.trades,
        distinctMarkets: agg.markets.size,
        estimatedPnlUsd: Math.round(combinedPnl * 100) / 100,
        estimatedWinRate: Math.round(estimatedWinRate * 1000) / 1000,
        estimatedRoi: Math.round(estimatedRoi * 10000) / 10000,
        maxSingleTradeUsd: Math.round(agg.maxSingleTradeUsd * 100) / 100,
        avgTradeUsd: Math.round((agg.volumeUsd / agg.trades) * 100) / 100,
        firstTradeTs: agg.firstTradeTs,
        lastTradeTs: agg.lastTradeTs,
        tradingSpanDays: Math.round(tradingSpanDays * 100) / 100,
        avgHoldTimeHrs: Math.round((avgHoldMs / 3_600_000) * 100) / 100,
        medianHoldTimeHrs: Math.round((medianHoldMs / 3_600_000) * 100) / 100,
        largestWinUsd: Math.round(totalLargestWin * 100) / 100,
        largestLossUsd: Math.round(totalLargestLoss * 100) / 100,
        longestWinStreak,
        longestLossStreak,
        currentStreak,
        closedTrades: totalClosedTrades + totalUnrealisedPositions,
        activityScore: Math.round(activityScore * 100) / 100,
        compositeScore,
        confidenceScore: Math.round(confidenceScore * 1000) / 1000,
        sharpeRatio: Math.round(sharpeRatio * 1000) / 1000,
        maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 10000,
        alreadyTracked: trackedAddrs.has(addr),
        alreadyCandidate: candidateAddrs.has(addr),
        suggestedTags,
        marketBreakdown: marketBreakdown.sort((a, b) => b.volumeUsd - a.volumeUsd),
        crossReferenced: this.crossReferencedAddresses.has(addr),
        clusterMarketIds: [],  // filled in by detectClusters()
      });
    }

    profiles.sort((a, b) => b.compositeScore - a.compositeScore);
    return profiles;
  }

  /* ━━━━━━━━━━━━━━ Max drawdown calculation ━━━━━━━━━━━━━━ */

  private computeMaxDrawdown(breakdown: ScannedMarketEntry[]): number {
    /* Build cumulative PnL series from per-market PnL */
    const pnls = breakdown.map((m) => m.estimatedPnlUsd);
    if (pnls.length === 0) return 0;
    let cumPnl = 0;
    let peak = 0;
    let maxDd = 0;
    for (const p of pnls) {
      cumPnl += p;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak > 0 ? (peak - cumPnl) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd;
  }

  /* ━━━━━━━━━━━━━━ FIFO PnL estimation (per-asset, enriched) ━━━━━━━━━━━━━━ */

  /**
   * Runs FIFO matching PER ASSET (outcome token) within a market.
   * Polymarket markets have separate Yes / No tokens — mixing them
   * in FIFO would produce nonsensical PnL.  We group buys & sells
   * by `assetId`, run FIFO independently for each token, then
   * aggregate the results.
   */
  private estimateMarketPnl(mAgg: MarketAgg): PnlResult {
    /* ── Group trades by asset token ── */
    const assetBuys = new Map<string, TradeEntry[]>();
    const assetSells = new Map<string, TradeEntry[]>();

    for (const b of mAgg.buys) {
      const key = b.assetId || '__unknown__';
      if (!assetBuys.has(key)) assetBuys.set(key, []);
      assetBuys.get(key)!.push(b);
    }
    for (const s of mAgg.sells) {
      const key = s.assetId || '__unknown__';
      if (!assetSells.has(key)) assetSells.set(key, []);
      assetSells.get(key)!.push(s);
    }

    /* Collect all unique asset ids that have BOTH buys and sells */
    const allAssets = new Set([...assetBuys.keys(), ...assetSells.keys()]);

    /* ── Aggregate accumulators ── */
    let totalPnl = 0;
    let totalClosedCount = 0;
    let totalWins = 0;
    let totalLargestWin = 0;
    let totalLargestLoss = 0;
    const allHoldTimesMs: number[] = [];
    let totalLongestWinStreak = 0;
    let totalLongestLossStreak = 0;
    let overallCurrentStreak = 0;
    let totalEntryPrice = 0;
    let totalEntryQty = 0;
    let totalExitPrice = 0;
    let totalExitQty = 0;
    let totalRemainingOpen = 0;
    let totalUnrealisedPnl = 0;
    let totalUnrealisedWins = 0;
    let totalUnrealisedPositions = 0;
    const perTradePnls: number[] = [];

    /* ── Run FIFO per asset ── */
    for (const assetId of allAssets) {
      const buys = (assetBuys.get(assetId) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      const sells = (assetSells.get(assetId) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));

      const openBuys: { price: number; remaining: number; ts: string }[] = [];

      for (const buy of buys) {
        openBuys.push({ price: buy.price, remaining: buy.size, ts: buy.ts });
        totalEntryPrice += buy.price * buy.size;
        totalEntryQty += buy.size;
      }

      let winStreak = 0;
      let lossStreak = 0;

      for (const sell of sells) {
        let remaining = sell.size;
        totalExitPrice += sell.price * sell.size;
        totalExitQty += sell.size;

        while (remaining > 0 && openBuys.length > 0) {
          const lot = openBuys[0];
          const closeQty = Math.min(remaining, lot.remaining);
          const tradePnl = closeQty * (sell.price - lot.price);
          totalPnl += tradePnl;
          totalClosedCount++;
          perTradePnls.push(tradePnl);

          const holdMs = new Date(sell.ts).getTime() - new Date(lot.ts).getTime();
          if (holdMs > 0) allHoldTimesMs.push(holdMs);

          if (tradePnl > 0) {
            totalWins++;
            totalLargestWin = Math.max(totalLargestWin, tradePnl);
            winStreak++;
            lossStreak = 0;
            totalLongestWinStreak = Math.max(totalLongestWinStreak, winStreak);
          } else if (tradePnl < 0) {
            totalLargestLoss = Math.min(totalLargestLoss, tradePnl);
            lossStreak++;
            winStreak = 0;
            totalLongestLossStreak = Math.max(totalLongestLossStreak, lossStreak);
          }

          lot.remaining -= closeQty;
          remaining -= closeQty;
          if (lot.remaining < 0.0001) openBuys.shift();
        }
      }

      /* Track current streak from last asset processed */
      if (winStreak > 0) overallCurrentStreak = winStreak;
      else if (lossStreak > 0) overallCurrentStreak = -lossStreak;

      /* ── Unrealised PnL: mark remaining open buys to current market price ── */
      const currentPrice = mAgg.currentPrices.get(assetId) ?? 0;
      for (const lot of openBuys) {
        totalRemainingOpen += lot.remaining;
        if (currentPrice > 0 && lot.remaining > 0.0001) {
          totalUnrealisedPositions++;
          const uPnl = lot.remaining * (currentPrice - lot.price);
          totalUnrealisedPnl += uPnl;
          if (uPnl > 0) totalUnrealisedWins++;
        }
      }
    }

    const avgEntryPrice = totalEntryQty > 0 ? totalEntryPrice / totalEntryQty : 0;
    const avgExitPrice = totalExitQty > 0 ? totalExitPrice / totalExitQty : 0;

    return {
      pnl: totalPnl,
      closedCount: totalClosedCount,
      wins: totalWins,
      largestWin: totalLargestWin,
      largestLoss: totalLargestLoss,
      holdTimesMs: allHoldTimesMs,
      longestWinStreak: totalLongestWinStreak,
      longestLossStreak: totalLongestLossStreak,
      currentStreak: overallCurrentStreak,
      avgEntryPrice: Math.round(avgEntryPrice * 10000) / 10000,
      avgExitPrice: Math.round(avgExitPrice * 10000) / 10000,
      remainingOpenSize: totalRemainingOpen,
      unrealisedPnl: totalUnrealisedPnl,
      unrealisedWins: totalUnrealisedWins,
      unrealisedPositions: totalUnrealisedPositions,
      perTradePnls,
    };
  }

  /* ━━━━━━━━━━━━━━ Step 4: Auto-promote top whales ━━━━━━━━━━━━━━ */

  private autoPromoteTopWhales(profiles: ScannedWhaleProfile[]): number {
    const minScore = this.scannerConfig.autoPromoteMinScore;
    const maxPerScan = this.scannerConfig.autoPromoteMaxPerScan;
    const minWinRate = this.scannerConfig.minWinRate;
    const minRoi = this.scannerConfig.minRoi;

    const eligible = profiles.filter((p) =>
      !p.alreadyTracked && !p.alreadyCandidate &&
      p.compositeScore >= minScore &&
      p.estimatedWinRate >= minWinRate &&
      p.estimatedRoi >= minRoi,
    );

    let promoted = 0;
    for (const profile of eligible.slice(0, maxPerScan)) {
      try {
        this.db.addWhale(profile.address, {
          displayName: undefined,
          tags: [...profile.suggestedTags, 'scanner_discovered'],
          notes: `Auto-discovered by scanner. Score: ${profile.compositeScore}, Win rate: ${(profile.estimatedWinRate * 100).toFixed(1)}%, ROI: ${(profile.estimatedRoi * 100).toFixed(1)}%, Volume: $${profile.totalVolumeUsd.toFixed(0)}`,
        });
        promoted++;
        logger.info({ address: profile.address.slice(0, 10) + '…', compositeScore: profile.compositeScore }, 'Scanner auto-promoted whale');
      } catch (err) {
        logger.warn({ err, address: profile.address.slice(0, 10) }, 'Scanner: failed to promote');
      }
    }
    return promoted;
  }

  /* ━━━━━━━━━━━━━━ Tag inference ━━━━━━━━━━━━━━ */

  private inferTags(agg: AddressAgg, winRate: number, roi: number, avgHoldMs: number): string[] {
    const tags: string[] = [];
    if (agg.volumeUsd > 100_000) tags.push('high_volume');
    else if (agg.volumeUsd > 25_000) tags.push('medium_volume');
    if (winRate >= 0.70) tags.push('sharp');
    else if (winRate >= 0.55) tags.push('profitable');
    if (roi > 0.20) tags.push('high_roi');
    if (agg.maxSingleTradeUsd > 10_000) tags.push('whale_size');
    if (agg.markets.size >= 5) tags.push('diversified');
    if (agg.markets.size === 1) tags.push('concentrated');
    if (agg.trades > 50) tags.push('frequent_trader');
    const holdHrs = avgHoldMs / 3_600_000;
    if (holdHrs > 0 && holdHrs < 1) tags.push('scalper');
    else if (holdHrs >= 1 && holdHrs < 24) tags.push('day_trader');
    else if (holdHrs > 168) tags.push('long_term_holder');
    let totalBuys = 0, totalSells = 0;
    for (const [, m] of agg.markets) { totalBuys += m.buys.length; totalSells += m.sells.length; }
    if (totalBuys > totalSells * 2) tags.push('aggressive_buyer');
    if (totalSells > totalBuys * 2) tags.push('aggressive_seller');
    return tags;
  }

  /* ━━━━━━━━━━━━━━ Big-trade spike detection ━━━━━━━━━━━━━━ */

  /**
   * Scan all aggregated trades for individual trades ≥ bigTradeMinUsd.
   * Addresses making large individual bets are high-signal whale candidates
   * even if their total volume is modest.
   */
  private detectBigTrades(): void {
    const minUsd = this.scannerConfig.bigTradeMinUsd;
    this.bigTradeAddresses.clear();

    for (const [addr, agg] of this.globalAgg) {
      if (agg.maxSingleTradeUsd >= minUsd) {
        this.bigTradeAddresses.set(addr, agg.maxSingleTradeUsd);
      }
    }

    if (this.bigTradeAddresses.size > 0) {
      logger.info({
        bigTraders: this.bigTradeAddresses.size,
        threshold: minUsd,
      }, 'Scanner: big-trade addresses detected');
    }
  }

  /* ━━━━━━━━━━━━━━ Cross-referencing: deep-scan top whales (PARALLEL) ━━━━━━━━━━━━━━ */

  /**
   * For the top N profiled whales, fetch their trades across ALL markets
   * (not just the ones we scanned). Uses semaphore for concurrent fetching.
   */
  private async crossReferenceTopWhales(): Promise<void> {
    const maxCrossRef = this.scannerConfig.crossRefMaxPerBatch;
    const topProfiles = this.latestProfiles
      .filter((p) => !this.crossReferencedAddresses.has(p.address) && p.compositeScore >= 50)
      .slice(0, maxCrossRef);

    if (topProfiles.length === 0) return;

    this.state.currentMarket = `Cross-referencing ${topProfiles.length} whales (parallel)…`;

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

    const crossRefOne = async (profile: ScannedWhaleProfile): Promise<void> => {
      if (!this.state.enabled) return;
      await this.semaphore.acquire();
      try {
        const ep = this.apiPool.pick('data-api');
        const baseUrl = ep ? ep.url : this.dataApi;
        const url = `${baseUrl}/trades?proxyWallet=${profile.address}&limit=1000`;
        if (ep) {
          await this.apiPool.waitForCapacity(ep);
        } else {
          await this.rateLimitWait();
        }
        const res = await this.fetchWithRetry(url);
        if (!res) { if (ep) this.apiPool.recordFailure(ep); return; }
        if (ep) this.apiPool.recordSuccess(ep);

        const raw: DataApiTrade[] = await res.json() as DataApiTrade[];
        if (!Array.isArray(raw) || raw.length === 0) return;

        const marketTrades = new Map<string, ClobTrade[]>();
        for (const t of raw) {
          if (!t.proxyWallet || !t.side || t.size == null || t.price == null) continue;
          const mktId = t.conditionId || 'unknown';
          if (!marketTrades.has(mktId)) marketTrades.set(mktId, []);
          marketTrades.get(mktId)!.push({
            id: t.transactionHash ?? '',
            market: mktId,
            asset_id: t.asset ?? '',
            side: (t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
            size: String(t.size),
            price: String(t.price),
            match_time: t.timestamp
              ? new Date(t.timestamp * 1000).toISOString()
              : new Date().toISOString(),
            owner: t.proxyWallet ?? '',
            outcome: t.outcome,
          });
        }

        for (const [mktId, trades] of marketTrades) {
          this.aggregateTrades(this.globalAgg, trades, mktId, `Market ${mktId.slice(0, 8)}…`);
        }

        this.crossReferencedAddresses.add(profile.address);
        logger.debug({
          address: profile.address.slice(0, 10) + '…',
          newMarkets: marketTrades.size,
        }, 'Cross-referenced whale');
      } catch {
        /* Non-fatal */
      } finally {
        this.semaphore.release();
      }
    };

    /* Fire all cross-references concurrently (semaphore limits parallelism) */
    await Promise.allSettled(topProfiles.map((p) => crossRefOne(p)));

    logger.info({
      crossReferenced: this.crossReferencedAddresses.size,
    }, 'Scanner: cross-referencing complete');
  }

  /* ━━━━━━━━━━━━━━ Whale cluster detection ━━━━━━━━━━━━━━ */

  /**
   * Detect markets where multiple top-scoring whales are active
   * within a recent time window. This is a strong copy-trade signal.
   */
  private detectClusters(): void {
    const minWhales = this.scannerConfig.clusterMinWhales;
    const windowMs = this.scannerConfig.clusterWindowHours * 3_600_000;
    const cutoff = new Date(Date.now() - windowMs).toISOString();

    /* Only consider profiles with decent scores */
    const qualifiedProfiles = this.latestProfiles.filter(
      (p) => p.compositeScore >= 40 && p.totalTrades >= 3,
    );

    /* Build market → whale addresses map */
    const marketWhales = new Map<string, { addresses: Set<string>; question: string; totalVol: number; buys: number; sells: number; firstTs: string; lastTs: string }>();

    for (const profile of qualifiedProfiles) {
      for (const mkt of profile.marketBreakdown) {
        /* Only consider recent activity */
        if (mkt.lastTradeTs < cutoff) continue;

        if (!marketWhales.has(mkt.marketId)) {
          marketWhales.set(mkt.marketId, {
            addresses: new Set(),
            question: mkt.question,
            totalVol: 0,
            buys: 0,
            sells: 0,
            firstTs: mkt.firstTradeTs,
            lastTs: mkt.lastTradeTs,
          });
        }
        const entry = marketWhales.get(mkt.marketId)!;
        entry.addresses.add(profile.address);
        entry.totalVol += mkt.volumeUsd;
        if (mkt.netSide === 'BUY') entry.buys++;
        else if (mkt.netSide === 'SELL') entry.sells++;
        if (mkt.firstTradeTs < entry.firstTs) entry.firstTs = mkt.firstTradeTs;
        if (mkt.lastTradeTs > entry.lastTs) entry.lastTs = mkt.lastTradeTs;
      }
    }

    /* Filter to clusters ≥ minWhales */
    this.latestClusters = [];
    for (const [marketId, data] of marketWhales) {
      if (data.addresses.size >= minWhales) {
        const avgScore = qualifiedProfiles
          .filter((p) => data.addresses.has(p.address))
          .reduce((sum, p) => sum + p.compositeScore, 0) / data.addresses.size;

        const dominantSide: 'BUY' | 'SELL' | 'MIXED' =
          data.buys > data.sells * 1.5 ? 'BUY' :
            data.sells > data.buys * 1.5 ? 'SELL' : 'MIXED';

        this.latestClusters.push({
          marketId,
          question: data.question,
          whaleAddresses: [...data.addresses],
          totalVolumeUsd: Math.round(data.totalVol * 100) / 100,
          dominantSide,
          firstTradeTs: data.firstTs,
          lastTradeTs: data.lastTs,
          avgCompositeScore: Math.round(avgScore),
        });

        /* Tag cluster markets on each whale's profile */
        for (const profile of this.latestProfiles) {
          if (data.addresses.has(profile.address)) {
            if (!profile.clusterMarketIds.includes(marketId)) {
              profile.clusterMarketIds.push(marketId);
            }
          }
        }
      }
    }

    this.latestClusters.sort((a, b) => b.whaleAddresses.length - a.whaleAddresses.length);

    if (this.latestClusters.length > 0) {
      logger.info({
        clusters: this.latestClusters.length,
        topCluster: this.latestClusters[0].question.slice(0, 40),
        topClusterWhales: this.latestClusters[0].whaleAddresses.length,
      }, 'Scanner: whale clusters detected');
    }
  }

  /* ━━━━━━━━━━━━━━ Rate limiting ━━━━━━━━━━━━━━ */

  /**
   * Lightweight global rate-limit check.  When ApiPool is active, per-endpoint
   * limits are already enforced by `waitForCapacity`, so we only need this
   * as a safety backstop and for non-pooled requests.
   */
  private async rateLimitWait(): Promise<void> {
    const maxReq = this.config.maxRequestsPerMinute;
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
    if (this.requestTimestamps.length >= maxReq) {
      const oldest = this.requestTimestamps[0];
      const waitMs = oldest + 60_000 - Date.now() + 50;  // reduced buffer from 100→50
      if (waitMs > 0) {
        logger.debug({ waitMs }, 'Scanner: rate limit wait');
        await this.sleep(waitMs);
      }
    }
    this.requestTimestamps.push(Date.now());
  }

  private async fetchWithRetry(url: string, maxRetries = 1, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return res;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
          await this.sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500) {
          await this.sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        return null;
      } catch (err: any) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') {
          logger.warn({ url, attempt }, 'Scanner fetch timed out after %dms', timeoutMs);
        }
        if (attempt === maxRetries) { logger.error({ err, attempt }, 'Scanner fetch failed'); return null; }
        await this.sleep(Math.pow(2, attempt) * 1000);
      }
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ━━━━━━━━━━━━━━ Fast-Scan Mode ━━━━━━━━━━━━━━ */

  /**
   * Rapid 60-second rescan of the hottest markets.  Detects whale entries
   * in near-real-time without waiting for the full 10-minute batch.
   */
  private startFastScan(): void {
    if (this.fastScanTimer) return;
    const cfg = this.scannerConfig.fastScan;
    logger.info({ intervalMs: cfg.intervalMs, topMarkets: cfg.topMarkets }, 'Fast-scan mode started');

    this.fastScanTimer = setInterval(() => {
      void this.runFastScan();
    }, cfg.intervalMs);
  }

  private stopFastScan(): void {
    if (this.fastScanTimer) {
      clearInterval(this.fastScanTimer);
      this.fastScanTimer = null;
    }
  }

  private async runFastScan(): Promise<void> {
    if (!this.state.enabled) return;
    const cfg = this.scannerConfig.fastScan;

    /* Use hotMarkets from last batch, or fetch top N */
    let markets = this.hotMarkets;
    if (markets.length === 0) {
      const ep = this.apiPool.pick('gamma-api');
      const baseUrl = ep ? ep.url : this.gammaApi;
      const url = `${baseUrl}/markets?active=true&closed=false&limit=${cfg.topMarkets}&order=volume24hr&ascending=false`;
      if (ep) await this.apiPool.waitForCapacity(ep);
      else await this.rateLimitWait();
      const res = await this.fetchWithRetry(url);
      if (!res) return;
      if (ep) this.apiPool.recordSuccess(ep);
      markets = (await res.json() as GammaMarket[]).filter((m) => m.acceptingOrders && m.conditionId);
    }

    const topN = markets.slice(0, cfg.topMarkets);
    let newBigTrades = 0;

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

    /* Process all fast-scan markets concurrently */
    const scanOne = async (market: GammaMarket): Promise<number> => {
      await this.semaphore.acquire();
      try {
        const ep = this.apiPool.pick('data-api');
        const baseUrl = ep ? ep.url : this.dataApi;
        const url = `${baseUrl}/trades?market=${market.conditionId}&limit=100&offset=0`;
        if (ep) await this.apiPool.waitForCapacity(ep);
        else await this.rateLimitWait();
        const res = await this.fetchWithRetry(url);
        if (!res) { if (ep) this.apiPool.recordFailure(ep); return 0; }
        if (ep) this.apiPool.recordSuccess(ep);

        const raw: DataApiTrade[] = await res.json() as DataApiTrade[];
        if (!Array.isArray(raw)) return 0;

        let bigTradesFound = 0;
        for (const t of raw) {
          if (!t.proxyWallet || !t.side || t.size == null || t.price == null) continue;
          const notional = Number(t.size) * Number(t.price);
          if (notional >= cfg.alertMinUsd) {
            const addr = t.proxyWallet.toLowerCase();
            const prev = this.bigTradeAddresses.get(addr) ?? 0;
            if (notional > prev) {
              this.bigTradeAddresses.set(addr, notional);
              bigTradesFound++;
            }
          }
        }

        const currentPrices = this.buildCurrentPriceMap(market);
        const mapped = raw
          .filter((t) => t.proxyWallet && t.side && t.size != null && t.price != null)
          .map((t) => ({
            id: t.transactionHash ?? '',
            market: market.conditionId,
            asset_id: t.asset ?? '',
            side: (t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
            size: String(t.size),
            price: String(t.price),
            match_time: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : new Date().toISOString(),
            owner: t.proxyWallet ?? '',
            outcome: t.outcome,
          }));
        this.aggregateTrades(this.globalAgg, mapped, market.conditionId, market.question, currentPrices);
        return bigTradesFound;
      } finally {
        this.semaphore.release();
      }
    };

    const results = await Promise.allSettled(topN.map((m) => scanOne(m)));
    for (const r of results) {
      if (r.status === 'fulfilled') newBigTrades += r.value;
    }

    if (newBigTrades > 0) {
      this.rebuildProfiles();
      logger.info({ newBigTrades, marketsScanned: topN.length }, 'Fast-scan: new big trades detected');
    }
  }

  /* ━━━━━━━━━━━━━━ Historical Backfill ━━━━━━━━━━━━━━ */

  /**
   * On first start, scan the past N days of trades for all liquid markets.
   * This gives much deeper profile data for accurate scoring.
   */
  private async runHistoricalBackfill(): Promise<void> {
    const days = this.scannerConfig.backfillDays;
    if (days <= 0) return;

    logger.info({ days }, 'Starting historical backfill');
    this.state.currentMarket = `Historical backfill (${days} days)…`;

    /* Fetch all liquid markets */
    const ep = this.apiPool.pick('gamma-api');
    const baseUrl = ep ? ep.url : this.gammaApi;
    const url = `${baseUrl}/markets?active=true&closed=false&limit=100&order=volume24hr&ascending=false`;
    if (ep) await this.apiPool.waitForCapacity(ep);
    else await this.rateLimitWait();
    const res = await this.fetchWithRetry(url);
    if (!res) return;
    if (ep) this.apiPool.recordSuccess(ep);

    const markets = (await res.json() as GammaMarket[]).filter(
      (m) => m.acceptingOrders && m.conditionId && Number(m.liquidityNum) >= MIN_LIQUIDITY_USD,
    );

    const topMarkets = markets.slice(0, Math.min(20, markets.length));
    this.hotMarkets = topMarkets;

    interface DataApiTrade {
      transactionHash?: string; proxyWallet?: string; side?: string;
      size?: number | string; price?: number | string; timestamp?: number;
      asset?: string; outcome?: string; conditionId?: string;
    }

    /* Backfill markets concurrently using semaphore */
    let backfillCompleted = 0;
    const backfillOne = async (market: GammaMarket): Promise<void> => {
      if (!this.state.enabled) return;
      await this.semaphore.acquire();
      try {
        const limit = this.scannerConfig.tradesPerMarket;
        const cutoff = Date.now() - days * 86_400_000;

        /* Fetch up to 10 pages concurrently per market */
        const fetchPage = async (page: number): Promise<ClobTrade[]> => {
          const offset = page * limit;
          const tep = this.apiPool.pick('data-api');
          const tUrl = `${tep ? tep.url : this.dataApi}/trades?market=${market.conditionId}&limit=${limit}&offset=${offset}`;
          if (tep) await this.apiPool.waitForCapacity(tep);
          else await this.rateLimitWait();
          const tRes = await this.fetchWithRetry(tUrl);
          if (!tRes) { if (tep) this.apiPool.recordFailure(tep); return []; }
          if (tep) this.apiPool.recordSuccess(tep);

          const raw: DataApiTrade[] = await tRes.json() as DataApiTrade[];
          if (!Array.isArray(raw) || raw.length === 0) return [];

          const recent = raw.filter((t) => {
            const ts = t.timestamp ? t.timestamp * 1000 : 0;
            return ts >= cutoff;
          });
          if (recent.length === 0) return [];

          return recent
            .filter((t) => t.proxyWallet && t.side && t.size != null && t.price != null)
            .map((t) => ({
              id: t.transactionHash ?? '',
              market: market.conditionId,
              asset_id: t.asset ?? '',
              side: (t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
              size: String(t.size),
              price: String(t.price),
              match_time: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : new Date().toISOString(),
              owner: t.proxyWallet ?? '',
              outcome: t.outcome,
            }));
        };

        /* Fire all 10 pages concurrently */
        const pageResults = await Promise.allSettled(
          Array.from({ length: 10 }, (_, i) => fetchPage(i)),
        );

        const currentPrices = this.buildCurrentPriceMap(market);
        for (const r of pageResults) {
          if (r.status === 'fulfilled' && r.value.length > 0) {
            this.aggregateTrades(this.globalAgg, r.value, market.conditionId, market.question, currentPrices);
          }
        }

        /* ── Live backfill progress ── */
        backfillCompleted++;
        this.state.currentMarket = `Backfill ${backfillCompleted}/${topMarkets.length} markets (${days}d history)…`;
        this.state.scanProgress = parseFloat(((backfillCompleted / topMarkets.length) * 50).toFixed(1));
        this.state.marketsScanned = backfillCompleted;
      } finally {
        this.semaphore.release();
      }
    };

    await Promise.allSettled(topMarkets.map((m) => backfillOne(m)));

    this.rebuildProfiles();
    logger.info({
      markets: topMarkets.length,
      profiles: this.latestProfiles.length,
      days,
    }, 'Historical backfill complete');
  }

  /* ━━━━━━━━━━━━━━ Cluster → Signal Pipeline ━━━━━━━━━━━━━━ */

  /**
   * Convert detected whale clusters into actionable ClusterSignals.
   * Assigns confidence based on whale count, score agreement, and direction consensus.
   */
  private generateClusterSignals(): void {
    const newSignals: ClusterSignal[] = [];

    for (const cluster of this.latestClusters) {
      /* Skip weak clusters */
      if (cluster.whaleAddresses.length < this.scannerConfig.clusterMinWhales) continue;

      /* Calculate confidence from multiple factors */
      const countFactor = Math.min(1, cluster.whaleAddresses.length / 10);  // more whales = higher
      const scoreFactor = Math.min(1, cluster.avgCompositeScore / 80);      // higher scores = higher
      const directionFactor = cluster.dominantSide !== 'MIXED' ? 0.8 : 0.3; // consensus = higher
      const volumeFactor = Math.min(1, cluster.totalVolumeUsd / 100_000);   // more volume = higher

      const confidence = Math.round((
        countFactor * 0.30 +
        scoreFactor * 0.30 +
        directionFactor * 0.25 +
        volumeFactor * 0.15
      ) * 1000) / 1000;

      /* Suggested position size: scale with confidence */
      const suggestedSizePct = Math.min(0.05, confidence * 0.05);

      const signal: ClusterSignal = {
        id: `cluster_${cluster.marketId}_${Date.now()}`,
        marketId: cluster.marketId,
        question: cluster.question,
        direction: cluster.dominantSide,
        confidence,
        whaleCount: cluster.whaleAddresses.length,
        avgWhaleScore: cluster.avgCompositeScore,
        totalVolumeUsd: cluster.totalVolumeUsd,
        suggestedSizePct,
        createdAt: new Date().toISOString(),
        ttlMs: 3_600_000,  // 1 hour validity
        consumed: false,
      };

      newSignals.push(signal);
    }

    /* Merge with existing signals, expire old ones */
    const now = Date.now();
    this.clusterSignals = [
      ...newSignals,
      ...this.clusterSignals.filter((s) => {
        const age = now - new Date(s.createdAt).getTime();
        return age < s.ttlMs && !s.consumed;
      }),
    ];

    if (newSignals.length > 0) {
      logger.info({
        newSignals: newSignals.length,
        totalActive: this.clusterSignals.length,
        topConfidence: newSignals[0]?.confidence,
      }, 'Cluster signals generated');
    }
  }

  /* ━━━━━━━━━━━━━━ Whale Network Graph ━━━━━━━━━━━━━━ */

  /**
   * Build a co-trading network graph: which whales trade together
   * in the same markets, in the same direction, at similar times.
   */
  private buildNetworkGraph(): void {
    const profiles = this.latestProfiles.filter((p) => p.compositeScore >= 30);
    if (profiles.length < 2) return;

    const edges: WhaleNetworkEdge[] = [];

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i];
        const b = profiles[j];

        /* Find shared markets */
        const aMarkets = new Set(a.marketBreakdown.map((m) => m.marketId));
        const bMarkets = new Set(b.marketBreakdown.map((m) => m.marketId));
        const shared = [...aMarkets].filter((m) => bMarkets.has(m));

        if (shared.length < 1) continue;

        /* Calculate direction agreement */
        let sameDirection = 0;
        let totalComparable = 0;
        for (const mktId of shared) {
          const aMkt = a.marketBreakdown.find((m) => m.marketId === mktId);
          const bMkt = b.marketBreakdown.find((m) => m.marketId === mktId);
          if (aMkt && bMkt && aMkt.netSide !== 'NEUTRAL' && bMkt.netSide !== 'NEUTRAL') {
            totalComparable++;
            if (aMkt.netSide === bMkt.netSide) sameDirection++;
          }
        }
        const directionAgreement = totalComparable > 0 ? sameDirection / totalComparable : 0;

        /* Calculate timing correlation (overlap of trade windows) */
        let timingOverlap = 0;
        for (const mktId of shared) {
          const aMkt = a.marketBreakdown.find((m) => m.marketId === mktId);
          const bMkt = b.marketBreakdown.find((m) => m.marketId === mktId);
          if (aMkt && bMkt) {
            const aStart = new Date(aMkt.firstTradeTs).getTime();
            const aEnd = new Date(aMkt.lastTradeTs).getTime();
            const bStart = new Date(bMkt.firstTradeTs).getTime();
            const bEnd = new Date(bMkt.lastTradeTs).getTime();
            const overlapStart = Math.max(aStart, bStart);
            const overlapEnd = Math.min(aEnd, bEnd);
            const overlap = Math.max(0, overlapEnd - overlapStart);
            const totalSpan = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
            if (totalSpan > 0) timingOverlap += overlap / totalSpan;
          }
        }
        const timingCorrelation = shared.length > 0 ? timingOverlap / shared.length : 0;

        edges.push({
          addressA: a.address,
          addressB: b.address,
          sharedMarkets: shared.length,
          sharedMarketIds: shared,
          directionAgreementPct: Math.round(directionAgreement * 100),
          timingCorrelation: Math.round(timingCorrelation * 1000) / 1000,
          combinedScore: Math.round((a.compositeScore + b.compositeScore) / 2),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    /* Sort by shared markets (strongest connections first) */
    edges.sort((a, b) => b.sharedMarkets - a.sharedMarkets);

    /* Find densest cluster using simple greedy approach */
    const adjacency = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.sharedMarkets < 2) continue;
      if (!adjacency.has(edge.addressA)) adjacency.set(edge.addressA, new Set());
      if (!adjacency.has(edge.addressB)) adjacency.set(edge.addressB, new Set());
      adjacency.get(edge.addressA)!.add(edge.addressB);
      adjacency.get(edge.addressB)!.add(edge.addressA);
    }

    let densestCluster: string[] = [];
    for (const [node, neighbors] of adjacency) {
      const cluster = [node, ...neighbors];
      if (cluster.length > densestCluster.length) {
        densestCluster = cluster;
      }
    }

    const avgConnectivity = profiles.length > 0
      ? edges.length / profiles.length : 0;

    this.networkGraph = {
      nodes: profiles.map((p) => ({
        address: p.address,
        compositeScore: p.compositeScore,
        totalVolumeUsd: p.totalVolumeUsd,
        label: p.suggestedTags[0] ?? 'unknown',
      })),
      edges: edges.slice(0, 500),  // cap for performance
      avgConnectivity: Math.round(avgConnectivity * 100) / 100,
      densestCluster: densestCluster.slice(0, 20),
      computedAt: new Date().toISOString(),
    };

    logger.info({
      nodes: this.networkGraph.nodes.length,
      edges: edges.length,
      densestClusterSize: densestCluster.length,
    }, 'Network graph built');
  }

  /* ━━━━━━━━━━━━━━ Copy-Trade Simulator ━━━━━━━━━━━━━━ */

  /**
   * For each top whale, simulate what would happen if we copied every trade
   * with assumed slippage and delay. Produces a CopySimResult showing
   * whether copying this whale is profitable after costs.
   */
  private runCopySimulations(): void {
    const slippageBps = this.scannerConfig.copySimSlippageBps;
    const delaySeconds = this.scannerConfig.copySimDelaySeconds;
    const topProfiles = this.latestProfiles
      .filter((p) => p.compositeScore >= 50 && p.closedTrades >= 5)
      .slice(0, 20);

    for (const profile of topProfiles) {
      const tradeLog: CopySimTrade[] = [];
      let cumPnl = 0;
      let peak = 0;
      let maxDd = 0;
      let wins = 0;
      const pnls: number[] = [];

      for (const mkt of profile.marketBreakdown) {
        /* Simulate: we enter at whale's avg entry + slippage, exit at their exit - slippage */
        if (mkt.positionStatus === 'closed' || mkt.openPositionSize > 0) {
          const slippageFactor = slippageBps / 10000;
          const simEntry = mkt.avgEntryPrice * (1 + slippageFactor);
          const simExit = mkt.avgExitPrice * (1 - slippageFactor);
          const size = mkt.volumeUsd / Math.max(mkt.avgEntryPrice, 0.01);
          const tradePnl = (simExit - simEntry) * size;

          cumPnl += tradePnl;
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak > 0 ? (peak - cumPnl) / peak : 0;
          if (dd > maxDd) maxDd = dd;
          if (tradePnl > 0) wins++;
          pnls.push(tradePnl);

          tradeLog.push({
            marketId: mkt.marketId,
            side: mkt.netSide === 'SELL' ? 'SELL' : 'BUY',
            whalePrice: mkt.avgEntryPrice,
            simEntryPrice: Math.round(simEntry * 10000) / 10000,
            size: Math.round(size * 100) / 100,
            pnl: Math.round(tradePnl * 100) / 100,
            ts: mkt.firstTradeTs,
          });
        }
      }

      /* Sharpe of simulated returns */
      let copySharpe = 0;
      if (pnls.length > 1) {
        const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / pnls.length;
        copySharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
      }

      this.copySimResults.set(profile.address, {
        whaleAddress: profile.address,
        simulatedPnlUsd: Math.round(cumPnl * 100) / 100,
        tradesCopied: tradeLog.length,
        copyWinRate: tradeLog.length > 0 ? Math.round((wins / tradeLog.length) * 1000) / 1000 : 0,
        maxDrawdownPct: Math.round(maxDd * 10000) / 10000,
        copySharpeRatio: Math.round(copySharpe * 1000) / 1000,
        assumedSlippageBps: slippageBps,
        fromTs: profile.firstTradeTs,
        toTs: profile.lastTradeTs,
        tradeLog,
      });
    }

    logger.info({
      simulated: topProfiles.length,
      profitable: [...this.copySimResults.values()].filter((r) => r.simulatedPnlUsd > 0).length,
    }, 'Copy-trade simulations complete');
  }

  /* ━━━━━━━━━━━━━━ Regime-Adaptive Scoring ━━━━━━━━━━━━━━ */

  /**
   * Detect current market regime (BULL/BEAR/CHOPPY/LOW_ACTIVITY)
   * and adjust scoring weights accordingly.
   */
  private evaluateRegime(): void {
    const profiles = this.latestProfiles;
    if (profiles.length < 5) return;

    /* Compute aggregate market metrics from profiled data */
    let totalPnl = 0;
    let totalVolume = 0;
    let activeMarkets = new Set<string>();
    const pnlValues: number[] = [];

    for (const p of profiles) {
      totalPnl += p.estimatedPnlUsd;
      totalVolume += p.totalVolumeUsd;
      for (const m of p.marketBreakdown) {
        activeMarkets.add(m.marketId);
        pnlValues.push(m.estimatedPnlUsd);
      }
    }

    const avgReturn = profiles.length > 0 ? totalPnl / profiles.length : 0;
    const volatility = pnlValues.length > 1
      ? Math.sqrt(pnlValues.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / pnlValues.length)
      : 0;

    /* Classify regime */
    let regime: MarketRegime;
    if (activeMarkets.size < 10 || totalVolume < 50_000) {
      regime = 'LOW_ACTIVITY';
    } else if (avgReturn > 50 && volatility < avgReturn * 2) {
      regime = 'BULL';
    } else if (avgReturn < -50 && volatility < Math.abs(avgReturn) * 2) {
      regime = 'BEAR';
    } else {
      regime = 'CHOPPY';
    }

    /* Adjust scoring weights based on regime */
    const adjustedWeights: Record<string, number> = { ...this.config.scoreWeights };
    switch (regime) {
      case 'BULL':
        /* In bull markets, reward momentum traders and volume */
        adjustedWeights.profitability = 0.35;
        adjustedWeights.timingSkill = 0.15;
        adjustedWeights.recencyActiveness = 0.15;
        break;
      case 'BEAR':
        /* In bear markets, reward risk management and consistency */
        adjustedWeights.consistency = 0.25;
        adjustedWeights.lowSlippage = 0.20;
        adjustedWeights.profitability = 0.25;
        break;
      case 'CHOPPY':
        /* In choppy markets, reward timing and slippage */
        adjustedWeights.timingSkill = 0.30;
        adjustedWeights.lowSlippage = 0.20;
        adjustedWeights.consistency = 0.20;
        break;
      case 'LOW_ACTIVITY':
        /* Low activity: rely on recency and market selection */
        adjustedWeights.recencyActiveness = 0.25;
        adjustedWeights.marketSelectionQuality = 0.20;
        break;
    }

    const confidence = Math.min(1, profiles.length / 50);

    this.regimeState = {
      regime,
      confidence: Math.round(confidence * 1000) / 1000,
      evaluatedAt: new Date().toISOString(),
      adjustedWeights,
      metrics: {
        avgMarketReturn24h: Math.round(avgReturn * 100) / 100,
        marketVolatility24h: Math.round(volatility * 100) / 100,
        activeMarketsCount: activeMarkets.size,
        totalVolume24h: Math.round(totalVolume * 100) / 100,
      },
    };

    logger.info({
      regime,
      confidence: this.regimeState.confidence,
      avgReturn: this.regimeState.metrics.avgMarketReturn24h,
    }, 'Regime evaluated');
  }

  /* ━━━━━━━━━━━━━━ Wallet Balance Lookup (Polygon RPC) ━━━━━━━━━━━━━━ */

  /**
   * Query on-chain USDC balance for top whale addresses via Polygon RPC.
   * Uses `eth_call` to read the USDC ERC-20 `balanceOf`.
   */
  private async lookupTopWalletBalances(): Promise<void> {
    const rpcUrl = this.scannerConfig.polygonRpcUrl;
    const usdcAddr = this.scannerConfig.usdcContractAddress;
    if (!rpcUrl || !usdcAddr) return;

    const topWhales = this.latestProfiles
      .filter((p) => p.compositeScore >= 60)
      .slice(0, 10);

    for (const whale of topWhales) {
      if (!this.state.enabled) break;

      try {
        /* ERC-20 balanceOf(address) selector = 0x70a08231 */
        const paddedAddr = whale.address.replace('0x', '').padStart(64, '0');
        const data = `0x70a08231${paddedAddr}`;

        const body = JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: usdcAddr, data }, 'latest'],
          id: 1,
        });

        await this.rateLimitWait();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const json = await res.json() as { result?: string };
          if (json.result) {
            /* USDC on Polygon has 6 decimals */
            const raw = BigInt(json.result);
            const balance = Number(raw) / 1_000_000;
            this.walletBalances.set(whale.address, balance);
          }
        }
      } catch {
        /* Non-fatal: RPC may be unavailable */
      }
    }

    if (this.walletBalances.size > 0) {
      logger.debug({ balancesLookedUp: this.walletBalances.size }, 'Wallet balance lookups done');
    }
  }

  /* ━━━━━━━━━━━━━━ Multi-Exchange Scanning ━━━━━━━━━━━━━━ */

  /**
   * Scan an external prediction market exchange for whale-like activity.
   * Currently supports Kalshi and Manifold Markets.
   */
  private async scanExternalExchange(source: ExchangeSource): Promise<void> {
    if (!source.enabled) return;

    try {
      switch (source.exchange) {
        case 'kalshi': {
          await this.scanKalshi(source);
          break;
        }
        case 'manifold': {
          await this.scanManifold(source);
          break;
        }
        default:
          logger.debug({ exchange: source.exchange }, 'Unsupported exchange — skipped');
      }
    } catch (err) {
      logger.warn({ err, exchange: source.exchange }, 'External exchange scan failed');
    }
  }

  private async scanKalshi(source: ExchangeSource): Promise<void> {
    /* Kalshi public API: fetch recent markets */
    const url = `${source.apiUrl}/markets?limit=20&status=open`;
    await this.rateLimitWait();
    const res = await this.fetchWithRetry(url);
    if (!res) return;

    interface KalshiMarket {
      ticker?: string;
      title?: string;
      volume?: number;
      open_interest?: number;
      yes_bid?: number;
      yes_ask?: number;
    }

    const data = await res.json() as { markets?: KalshiMarket[] };
    const markets = data.markets ?? [];

    logger.info({
      exchange: 'kalshi',
      marketsDiscovered: markets.length,
    }, 'Kalshi scan complete');

    /* Note: Kalshi doesn't expose individual trader addresses publicly,
       so we track market-level signals for cross-reference with Polymarket */
  }

  private async scanManifold(source: ExchangeSource): Promise<void> {
    /* Manifold public API: fetch trending markets */
    const url = `${source.apiUrl}/markets?sort=most-traded&limit=20`;
    await this.rateLimitWait();
    const res = await this.fetchWithRetry(url);
    if (!res) return;

    interface ManifoldMarket {
      id?: string;
      question?: string;
      volume?: number;
      totalLiquidity?: number;
    }

    const markets: ManifoldMarket[] = await res.json() as ManifoldMarket[];

    /* Manifold has public bet history — could cross-reference with Poly wallets */
    logger.info({
      exchange: 'manifold',
      marketsDiscovered: markets.length,
    }, 'Manifold scan complete');
  }

  /* ━━━━━━━━━━━━━━ Memory Management ━━━━━━━━━━━━━━ */

  /**
   * Prevents unbounded accumulators from exhausting the Node.js heap
   * by pruning old trades and keeping map sizes below safety thresholds.
   */
  private pruneUnboundedState(): void {
    const nowMs = Date.now();
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const [addr, agg] of this.globalAgg) {
      // 1. Remove addresses that haven't traded in MAX_AGE_MS
      if (nowMs - new Date(agg.lastTradeTs).getTime() > MAX_AGE_MS) {
        this.globalAgg.delete(addr);
        continue;
      }

      // 2. Bound trades inner arrays and inactive markets
      for (const [mktId, mAgg] of agg.markets) {
        if (nowMs - new Date(mAgg.lastTradeTs).getTime() > MAX_AGE_MS) {
          agg.markets.delete(mktId);
          continue;
        }

        const MAX_TRADES = 2000;
        if (mAgg.buys.length > MAX_TRADES) mAgg.buys.splice(0, mAgg.buys.length - MAX_TRADES);
        if (mAgg.sells.length > MAX_TRADES) mAgg.sells.splice(0, mAgg.sells.length - MAX_TRADES);
      }
    }

    // 3. Keep maximum number of addresses based on recency
    const MAX_ADDRESSES = 20000;
    if (this.globalAgg.size > MAX_ADDRESSES) {
      const entries = Array.from(this.globalAgg.entries());
      entries.sort((a, b) => new Date(b[1].lastTradeTs).getTime() - new Date(a[1].lastTradeTs).getTime());

      this.globalAgg.clear();
      for (let i = 0; i < MAX_ADDRESSES; i++) {
        if (entries[i]) this.globalAgg.set(entries[i][0], entries[i][1]);
      }
    }

    // 4. Clear unneeded wallet balances & copy simulations cache
    if (this.walletBalances.size > MAX_ADDRESSES) this.walletBalances.clear();
    if (this.copySimResults.size > 5000) this.copySimResults.clear();
  }
}
