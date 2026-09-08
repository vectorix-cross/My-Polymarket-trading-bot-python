/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking Engine — Type Definitions
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ── Enums ── */

export type WhaleStyle = 'MARKET_MAKER' | 'INFORMED' | 'EXIT_LIQUIDITY' | 'SCALPER' | 'ACCUMULATOR' | 'CONTRARIAN' | 'MOMENTUM' | 'UNKNOWN';
export type DataIntegrity = 'HEALTHY' | 'DEGRADED' | 'BACKFILLING';
export type AggressorSide = 'BUY' | 'SELL' | 'UNKNOWN';
export type CostBasisMethod = 'FIFO' | 'AVG';

export type AlertType =
  | 'new_trade'
  | 'new_position'
  | 'scale_in'
  | 'partial_exit'
  | 'full_exit'
  | 'flip_direction'
  | 'unusually_large_trade'
  | 'near_resolution_trade'
  | 'spread_widening_trade'
  | 'new_category_entry'
  | 'score_change'
  | 'data_integrity_change'
  | 'large_trade'
  | 'new_market_entry'
  | 'position_flip'
  | 'whale_coordination'
  | 'score_surge'
  | 'score_drop'
  | 'drawdown_alert';

export type SignalType =
  | 'whale_trade'
  | 'whale_open'
  | 'whale_exit'
  | 'whale_flip'
  | 'whale_impact'
  | 'spread_blowout'
  | 'depth_collapse'
  | 'shadow_performance_change'
  | 'large_trade_detected'
  | 'new_market_entry'
  | 'whale_cluster';

export type CopyMode = 'ALERTS_ONLY' | 'PAPER_SHADOW' | 'LIVE_COPY';

/* ── Core Entities ── */

export interface Whale {
  id: number;
  address: string;
  displayName: string | null;
  starred: boolean;
  trackingEnabled: boolean;
  tags: string[];
  notes: string;
  style: WhaleStyle;
  dataIntegrity: DataIntegrity;
  copyMode: CopyMode;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  lastBackfillAt: string | null;
  lastTradeCursor: string | null;
}

export interface WhaleTrade {
  id: number;
  whaleId: number;
  tradeId: string | null;
  logicalTradeGroupId: string | null;
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  notionalUsd: number;
  feeUsd: number;
  isFeeEstimated: boolean;
  ts: string;
  midpointAtFill: number | null;
  bestBidAtFill: number | null;
  bestAskAtFill: number | null;
  slippageBps: number | null;
  aggressor: AggressorSide;
}

export interface WhalePosition {
  whaleId: number;
  marketId: string;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  costBasis: number;
  unrealizedPnl: number;
  updatedAt: string;
}

export interface WhaleMetricsDaily {
  whaleId: number;
  date: string;
  realizedPnl: number;
  unrealizedPnl: number;
  volumeUsd: number;
  tradesCount: number;
  winRate: number;
  avgSlippageBps: number;
  avgHoldMinutes: number;
  timingScore: number;
  consistencyScore: number;
  marketSelectionScore: number;
  score: number;
  scoreConfidence: number;
  scoreVersion: string;
}

export interface SettlementLedgerEntry {
  id: number;
  whaleId: number;
  marketId: string;
  outcome: string;
  lotId: string;
  openTs: string;
  closeTs: string | null;
  qty: number;
  entryPrice: number;
  exitPriceOrSettlement: number | null;
  realizedPnl: number;
  feeUsd: number;
  method: CostBasisMethod;
  isEstimatedFee: boolean;
}

export interface WhaleCandidate {
  id: number;
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
  volumeUsd24h: number;
  trades24h: number;
  maxSingleTradeUsd: number;
  markets7d: number;
  rankScore: number;
  suggestedTags: string[];
  mutedUntil: string | null;
  approved: boolean;
}

export interface Alert {
  id: number;
  whaleId: number | null;
  type: AlertType;
  payload: Record<string, unknown>;
  createdAt: string;
  delivered: boolean;
  readAt: string | null;
}

export interface Signal {
  id: number;
  type: SignalType;
  payload: Record<string, unknown>;
  createdAt: string;
  cursorKey: string;
}

export interface Watchlist {
  id: number;
  name: string;
  createdAt: string;
}

export interface WatchlistItem {
  watchlistId: number;
  whaleId: number;
}

export interface ShadowPortfolio {
  id: number;
  whaleId: number;
  mode: 'paper';
  positions: ShadowPosition[];
  pnlSeries: number[];
  totalPnl: number;
  drawdown: number;
  lastUpdated: string;
}

export interface ShadowPosition {
  marketId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  shares: number;
  entryPrice: number;
  entryTs: string;
}

/* ── Score breakdown ── */

export interface WhaleScoreBreakdown {
  overall: number;
  confidence: number;
  provisional: boolean;
  components: {
    profitability: number;          // 30% weight
    timingSkill: number;            // 20%
    lowSlippage: number;            // 15%
    consistency: number;            // 15%
    marketSelectionQuality: number; // 10%
    recencyActiveness: number;      // 10%
  };
  weights: {
    profitability: number;
    timingSkill: number;
    lowSlippage: number;
    consistency: number;
    marketSelectionQuality: number;
    recencyActiveness: number;
  };
  sampleSize: number;
  dataIntegrityModifier: number;
  computedAt: string;
  version: string;
}

/* ── Timing analysis ── */

export interface TimingWindow {
  windowMinutes: number;
  favorableMovesPct: number;
  avgMoveSize: number;
  sampleSize: number;
}

/* ── API response shapes ── */

export interface WhaleListResponse {
  whales: WhaleListItem[];
  cursor: string | null;
  total: number;
}

export interface WhaleListItem extends Whale {
  marketsTraded30d: number;
  marketsTraded_lifetime: number;
  totalVolume30d: number;
  totalVolume_lifetime: number;
  realizedPnl30d: number;
  realizedPnl_lifetime: number;
  unrealizedPnl: number;
  winRate: number;
  avgHoldMinutes: number;
  avgSlippageBps: number;
  consistencyScore: number;
  whaleScore: number;
  scoreProvisional: boolean;
}

export interface WhaleDetailResponse {
  whale: Whale;
  scoreBreakdown: WhaleScoreBreakdown;
  equityCurve: { date: string; pnl: number }[];
  recentTrades: WhaleTrade[];
  openPositions: WhalePosition[];
  categoryDistribution: { category: string; count: number; volumeUsd: number }[];
  timingAnalysis: TimingWindow[];
}

export interface MarketWhaleActivity {
  marketId: string;
  whaleNetFlow: { outcome: string; netUsd: number }[];
  biggestPrints: WhaleTrade[];
  concentration: { whaleId: number; address: string; pct: number }[];
  recentEntries: WhaleTrade[];
  recentExits: WhaleTrade[];
}

/* ── Scanner Types ── */

export type ScannerStatus = 'idle' | 'scanning' | 'paused' | 'error';

export interface ScannerState {
  status: ScannerStatus;
  enabled: boolean;
  lastScanAt: string | null;
  nextScanAt: string | null;
  marketsScanned: number;
  /** Total unique markets discovered across all batches */
  totalMarketsDiscovered: number;
  addressesAnalysed: number;
  /** Alias used by dashboard — same as addressesAnalysed */
  profilesFound: number;
  /** Addresses that met the auto-promote score threshold */
  qualifiedCount: number;
  whalesPromoted: number;
  currentMarket: string | null;
  scanProgress: number;           // 0-100
  lastError: string | null;
  /** Duration of the most recent batch in milliseconds */
  scanDurationMs: number | null;
  /** Total wall-clock uptime since scanner started (ms) */
  totalScanTimeMs: number;
  totalScansCompleted: number;
  /** Current batch number (increments each continuous loop iteration) */
  batchNumber: number;
  /** Markets remaining in current batch */
  marketsInCurrentBatch: number;
  /** Performance metrics for current/last scan */
  perf?: {
    marketsPerSecond: number;
    tradesPerSecond: number;
    avgFetchLatencyMs: number;
    totalFetches: number;
    totalTradesFetched: number;
    parallelEfficiency: number;
    concurrentWorkers: number;
  };
  /** Active scanner config (read-only snapshot) */
  scannerConfig?: {
    parallelFetchBatch: number;
    maxRequestsPerMinute: number;
    marketsPerScan: number;
    minVolume: number;
    minLiquidity: number;
  };
}

/** Profile assembled for each address discovered during a market scan */
export interface ScannedWhaleProfile {
  address: string;
  /** Aggregate stats across all scanned markets */
  totalVolumeUsd: number;
  totalTrades: number;
  distinctMarkets: number;
  /** Approximate profitability from trade-pairs */
  estimatedPnlUsd: number;
  estimatedWinRate: number;
  estimatedRoi: number;
  maxSingleTradeUsd: number;
  avgTradeUsd: number;
  /** Earliest trade seen */
  firstTradeTs: string;
  /** How recently they were active */
  lastTradeTs: string;
  /** Span between first and last trade in days */
  tradingSpanDays: number;
  /** Average time holding a position (buy→sell) in hours */
  avgHoldTimeHrs: number;
  /** Median hold time in hours */
  medianHoldTimeHrs: number;
  /** Largest single winning trade in USD */
  largestWinUsd: number;
  /** Largest single losing trade in USD */
  largestLossUsd: number;
  /** Win/loss streaks */
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: number;           // positive = winning, negative = losing
  /** Total closed round-trip trades matched */
  closedTrades: number;
  /** Recency-weighted volume (more recent = higher) */
  activityScore: number;
  /** Composite ranking score (0-100) factoring in volume, win rate, ROI */
  compositeScore: number;
  /** Statistical confidence in the composite score (0-1) based on sample size */
  confidenceScore: number;
  /** Risk-adjusted return: mean PnL per trade / stddev of per-trade PnL */
  sharpeRatio: number;
  /** Peak-to-trough drawdown fraction across cumulative PnL series */
  maxDrawdownPct: number;
  /** Whether this address already exists as a tracked whale */
  alreadyTracked: boolean;
  /** Whether this address already exists as a candidate */
  alreadyCandidate: boolean;
  /** Tags inferred from behaviour */
  suggestedTags: string[];
  /** Per-market breakdown */
  marketBreakdown: ScannedMarketEntry[];
  /** Whether profile was enriched via cross-referencing (deep scan) */
  crossReferenced: boolean;
  /** Market IDs where this whale clusters with other discovered whales */
  clusterMarketIds: string[];
}

export interface ScannedMarketEntry {
  marketId: string;
  question: string;
  volumeUsd: number;
  trades: number;
  netSide: 'BUY' | 'SELL' | 'NEUTRAL';
  estimatedPnlUsd: number;
  /** Average buy price */
  avgEntryPrice: number;
  /** Average sell price */
  avgExitPrice: number;
  /** Average hold time for round-trips in this market (hours) */
  avgHoldTimeHrs: number;
  /** Remaining open position size (buys - sells) */
  openPositionSize: number;
  /** 'active' if there is remaining open position, 'closed' otherwise */
  positionStatus: 'active' | 'closed';
  firstTradeTs: string;
  lastTradeTs: string;
}

export interface ScannerConfig {
  enabled: boolean;
  /** Interval between full scans (ms) */
  scanIntervalMs: number;
  /** Number of top liquid markets to scan per cycle */
  marketsPerScan: number;
  /** Minimum market liquidity to include */
  minMarketLiquidityUsd: number;
  /** Minimum 24h volume for a market to be scanned */
  minMarketVolume24hUsd: number;
  /** Max trades to pull per market from CLOB */
  tradesPerMarket: number;
  /** Number of trade pages to fetch per market (each page = tradesPerMarket) */
  tradePageDepth: number;
  /** Address must have at least this volume to be profiled */
  minAddressVolumeUsd: number;
  /** Address must have at least this many trades */
  minAddressTrades: number;
  /** Minimum estimated win rate to be considered a top whale */
  minWinRate: number;
  /** Minimum estimated ROI to be considered a top whale */
  minRoi: number;
  /** Minimum composite score (0-100) to auto-promote */
  autoPromoteMinScore: number;
  /** Whether to auto-promote qualifying whales to tracked */
  autoPromoteEnabled: boolean;
  /** Max whales to auto-promote per scan cycle */
  autoPromoteMaxPerScan: number;
  /** Minimum notional for a trade to be flagged as a "big trade" (USD) */
  bigTradeMinUsd: number;
  /** Enable cross-referencing: when a whale is found, scan all their activity */
  crossRefEnabled: boolean;
  /** Max addresses to cross-reference per batch */
  crossRefMaxPerBatch: number;
  /** Enable whale cluster detection */
  clusterDetectionEnabled: boolean;
  /** Minimum whales converging on same market to trigger cluster */
  clusterMinWhales: number;
  /** Cluster time window (hours): whales must have traded within this window */
  clusterWindowHours: number;
  /** Number of parallel market fetches per batch */
  parallelFetchBatch: number;
  /** Multi-API pool configuration for rate-limit bypass */
  apiPool: ApiPoolConfig;
  /** Fast-scan mode for near-real-time whale detection */
  fastScan: FastScanConfig;
  /** Historical backfill: scan past N days on first run */
  backfillDays: number;
  /** Polygon RPC URL for on-chain balance lookups */
  polygonRpcUrl: string;
  /** USDC contract address on Polygon */
  usdcContractAddress: string;
  /** Enable whale network graph analysis */
  networkGraphEnabled: boolean;
  /** Enable copy-trade simulation */
  copySimEnabled: boolean;
  /** Default slippage assumption for copy sim (bps) */
  copySimSlippageBps: number;
  /** Default copy delay assumption (seconds) */
  copySimDelaySeconds: number;
  /** Enable regime-adaptive scoring */
  regimeAdaptiveEnabled: boolean;
  /** Multi-exchange sources */
  exchangeSources: ExchangeSource[];
}

/** Whale cluster: multiple discovered whales converging on the same market */
export interface WhaleCluster {
  marketId: string;
  question: string;
  whaleAddresses: string[];
  totalVolumeUsd: number;
  dominantSide: 'BUY' | 'SELL' | 'MIXED';
  firstTradeTs: string;
  lastTradeTs: string;
  avgCompositeScore: number;
}

/* ━━━━━━━━━━━━━━ Multi-API Pool ━━━━━━━━━━━━━━ */

/** Supported API provider types */
export type ApiProviderType = 'data-api' | 'gamma-api' | 'subgraph' | 'polygon-rpc';

/** A single API endpoint in the rotation pool */
export interface ApiEndpoint {
  /** Human-friendly name */
  name: string;
  /** Base URL */
  url: string;
  /** Which kind of data this provides */
  type: ApiProviderType;
  /** Independent rate limit (requests per minute) for this endpoint */
  maxRequestsPerMinute: number;
  /** Whether this endpoint is currently healthy */
  healthy: boolean;
  /** Timestamp of last successful request */
  lastSuccessAt: number | null;
  /** Timestamp of last failed request */
  lastFailAt: number | null;
  /** Consecutive failures (auto-disable after threshold) */
  consecutiveFailures: number;
  /** Maximum consecutive failures before marking unhealthy */
  maxConsecutiveFailures: number;
  /** Weight for weighted-random selection (higher = preferred) */
  weight: number;
  /** Request timestamps for this endpoint's rate limiter */
  requestTimestamps: number[];
  /** Optional API key / auth header */
  apiKey?: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
}

/** Configuration for the multi-API pool */
export interface ApiPoolConfig {
  /** Enable multi-API rotation */
  enabled: boolean;
  /** Strategy for selecting next API: round-robin, least-loaded, weighted-random */
  selectionStrategy: 'round-robin' | 'least-loaded' | 'weighted-random';
  /** Auto-heal: re-try unhealthy endpoints after this many ms */
  healthCheckIntervalMs: number;
  /** Custom endpoints from config */
  endpoints: ApiEndpointConfig[];
}

/** Config file shape for an endpoint (simpler than runtime ApiEndpoint) */
export interface ApiEndpointConfig {
  name: string;
  url: string;
  type: ApiProviderType;
  maxRequestsPerMinute: number;
  weight?: number;
  apiKey?: string;
  headers?: Record<string, string>;
}

export const DEFAULT_API_POOL_CONFIG: ApiPoolConfig = {
  enabled: true,
  selectionStrategy: 'least-loaded',
  healthCheckIntervalMs: 120_000,
  endpoints: [],
};

/* ━━━━━━━━━━━━━━ Fast-Scan Mode ━━━━━━━━━━━━━━ */

/** Fast-scan: rapid rescan of hottest markets */
export interface FastScanConfig {
  /** Enable fast-scan mode */
  enabled: boolean;
  /** Interval between fast scans (ms) — default 60s */
  intervalMs: number;
  /** Number of top-volume markets to quick-scan */
  topMarkets: number;
  /** Only alert on trades ≥ this amount during fast-scan */
  alertMinUsd: number;
}

export const DEFAULT_FAST_SCAN_CONFIG: FastScanConfig = {
  enabled: true,
  intervalMs: 60_000,
  topMarkets: 5,
  alertMinUsd: 5_000,
};

/* ━━━━━━━━━━━━━━ Cluster Signal ━━━━━━━━━━━━━━ */

/** Trading signal generated from whale cluster convergence */
export interface ClusterSignal {
  /** Unique ID for this signal */
  id: string;
  /** Market the cluster is converging on */
  marketId: string;
  question: string;
  /** Dominant direction */
  direction: 'BUY' | 'SELL' | 'MIXED';
  /** Signal confidence 0-1 based on whale count, scores, agreement */
  confidence: number;
  /** Number of whales in the cluster */
  whaleCount: number;
  /** Average composite score of cluster whales */
  avgWhaleScore: number;
  /** Total whale volume in this market */
  totalVolumeUsd: number;
  /** Suggested position size as fraction of capital (0-1) */
  suggestedSizePct: number;
  /** When the signal was generated */
  createdAt: string;
  /** Signal validity window (ms) */
  ttlMs: number;
  /** Whether this signal has been acted upon */
  consumed: boolean;
}

/* ━━━━━━━━━━━━━━ Whale Network Graph ━━━━━━━━━━━━━━ */

/** An edge in the whale co-trading network */
export interface WhaleNetworkEdge {
  /** First whale address */
  addressA: string;
  /** Second whale address */
  addressB: string;
  /** Number of markets both traded in */
  sharedMarkets: number;
  /** Market IDs they share */
  sharedMarketIds: string[];
  /** How often they trade in the same direction */
  directionAgreementPct: number;
  /** Correlation of their trade timing (0-1) */
  timingCorrelation: number;
  /** Combined composite score */
  combinedScore: number;
  /** When this edge was last updated */
  updatedAt: string;
}

/** Full network graph for API response */
export interface WhaleNetworkGraph {
  nodes: { address: string; compositeScore: number; totalVolumeUsd: number; label: string }[];
  edges: WhaleNetworkEdge[];
  /** Average connectivity (edges per node) */
  avgConnectivity: number;
  /** Strongest cluster of connected whales */
  densestCluster: string[];
  computedAt: string;
}

/* ━━━━━━━━━━━━━━ Copy-Trade Simulator ━━━━━━━━━━━━━━ */

/** Result of a simulated copy-trade for a whale */
export interface CopySimResult {
  whaleAddress: string;
  /** Simulated PnL if we had copied every trade */
  simulatedPnlUsd: number;
  /** Number of trades simulated */
  tradesCopied: number;
  /** Win rate of copied trades */
  copyWinRate: number;
  /** Maximum simulated drawdown */
  maxDrawdownPct: number;
  /** Sharpe ratio of simulated returns */
  copySharpeRatio: number;
  /** Average slippage assumed (bps) */
  assumedSlippageBps: number;
  /** Simulation period */
  fromTs: string;
  toTs: string;
  /** Per-trade breakdown */
  tradeLog: CopySimTrade[];
}

export interface CopySimTrade {
  marketId: string;
  side: 'BUY' | 'SELL';
  whalePrice: number;
  /** Price we'd get after assumed delay + slippage */
  simEntryPrice: number;
  size: number;
  pnl: number;
  ts: string;
}

/* ━━━━━━━━━━━━━━ Regime-Adaptive Scoring ━━━━━━━━━━━━━━ */

export type MarketRegime = 'BULL' | 'BEAR' | 'CHOPPY' | 'LOW_ACTIVITY';

export interface RegimeState {
  /** Current detected regime */
  regime: MarketRegime;
  /** Confidence in regime detection (0-1) */
  confidence: number;
  /** When regime was last evaluated */
  evaluatedAt: string;
  /** Adjusted score weights for this regime */
  adjustedWeights: Record<string, number>;
  /** Metrics used to detect regime */
  metrics: {
    avgMarketReturn24h: number;
    marketVolatility24h: number;
    activeMarketsCount: number;
    totalVolume24h: number;
  };
}

/* ━━━━━━━━━━━━━━ Multi-Exchange Scanning ━━━━━━━━━━━━━━ */

export type ExchangeId = 'polymarket' | 'kalshi' | 'metaculus' | 'manifold';

export interface ExchangeSource {
  /** Exchange identifier */
  exchange: ExchangeId;
  /** API base URL */
  apiUrl: string;
  /** Whether this source is enabled */
  enabled: boolean;
  /** Rate limit for this exchange */
  maxRequestsPerMinute: number;
  /** Custom API key */
  apiKey?: string;
}

export const DEFAULT_EXCHANGE_SOURCES: ExchangeSource[] = [
  { exchange: 'polymarket', apiUrl: 'https://data-api.polymarket.com', enabled: true, maxRequestsPerMinute: 60 },
  { exchange: 'kalshi', apiUrl: 'https://trading-api.kalshi.com/trade-api/v2', enabled: false, maxRequestsPerMinute: 30 },
  { exchange: 'manifold', apiUrl: 'https://api.manifold.markets/v0', enabled: false, maxRequestsPerMinute: 60 },
];

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  enabled: false,
  scanIntervalMs: 600_000,        // 10 minutes
  marketsPerScan: 20,
  minMarketLiquidityUsd: 10_000,
  minMarketVolume24hUsd: 5_000,
  tradesPerMarket: 500,
  tradePageDepth: 3,
  minAddressVolumeUsd: 5_000,
  minAddressTrades: 5,
  minWinRate: 0.55,
  minRoi: 0.05,
  autoPromoteMinScore: 70,
  autoPromoteEnabled: false,
  autoPromoteMaxPerScan: 3,
  bigTradeMinUsd: 5_000,
  crossRefEnabled: true,
  crossRefMaxPerBatch: 10,
  clusterDetectionEnabled: true,
  clusterMinWhales: 3,
  clusterWindowHours: 24,
  parallelFetchBatch: 5,
  apiPool: { ...DEFAULT_API_POOL_CONFIG },
  fastScan: { ...DEFAULT_FAST_SCAN_CONFIG },
  backfillDays: 7,
  polygonRpcUrl: 'https://polygon-rpc.com',
  usdcContractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  networkGraphEnabled: true,
  copySimEnabled: true,
  copySimSlippageBps: 30,
  copySimDelaySeconds: 10,
  regimeAdaptiveEnabled: true,
  exchangeSources: [...DEFAULT_EXCHANGE_SOURCES],
};

/* ── Configuration ── */

export interface WhaleTrackingConfig {
  enabled: boolean;
  dbPath: string;
  /* ── Ingestion ── */
  pollIntervalMs: number;
  backfillBatchSize: number;
  maxRequestsPerMinute: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /* ── Candidate discovery ── */
  candidateScanIntervalMs: number;
  candidateMinVolumeUsd24h: number;
  candidateMinTrades24h: number;
  candidateAutoTrackTopK: number;
  /* ── Scoring ── */
  scoreVersion: string;
  scoreWeights: {
    profitability: number;
    timingSkill: number;
    lowSlippage: number;
    consistency: number;
    marketSelectionQuality: number;
    recencyActiveness: number;
  };
  provisionalMinTrades: number;
  provisionalMaxScore: number;
  costBasisMethod: CostBasisMethod;
  /* ── Timing windows (minutes) ── */
  timingWindows: number[];
  /* ── Alerts ── */
  alertDigestIntervalMs: number;
  largeTradeSigmaThreshold: number;
  nearResolutionHours: number;
  /* ── Copy guardrails ── */
  copy: {
    maxCopyDelaySeconds: number;
    maxEntryDriftBps: number;
    maxSpreadBps: number;
    minDepthUsd: number;
    minLiquidityUsd: number;
    maxSizePerTradeUsd: number;
    maxSizePerMarketUsd: number;
    maxSizePerDayUsd: number;
    stopCopyDrawdownPct: number;
    stopCopyMinScore: number;
    minShadowWindowDays: number;
  };
  /* ── Reconciliation ── */
  reconcileIntervalMs: number;
  reconcileLookbackDays: number;
  /* ── Metadata cache ── */
  metadataCacheTtlMs: number;
  /* ── Webhook (optional) ── */
  telegramWebhookUrl: string | null;
  /* ── Market Scanner ── */
  scanner: ScannerConfig;
}

export const DEFAULT_WHALE_CONFIG: WhaleTrackingConfig = {
  enabled: true,
  dbPath: '.runtime/whales.db',
  pollIntervalMs: 30_000,
  backfillBatchSize: 100,
  maxRequestsPerMinute: 30,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  candidateScanIntervalMs: 300_000,
  candidateMinVolumeUsd24h: 10_000,
  candidateMinTrades24h: 10,
  candidateAutoTrackTopK: 0,
  scoreVersion: '1.0.0',
  scoreWeights: {
    profitability: 0.30,
    timingSkill: 0.20,
    lowSlippage: 0.15,
    consistency: 0.15,
    marketSelectionQuality: 0.10,
    recencyActiveness: 0.10,
  },
  provisionalMinTrades: 30,
  provisionalMaxScore: 65,
  costBasisMethod: 'FIFO',
  timingWindows: [5, 30, 240, 1440],
  alertDigestIntervalMs: 60_000,
  largeTradeSigmaThreshold: 2.5,
  nearResolutionHours: 24,
  copy: {
    maxCopyDelaySeconds: 120,
    maxEntryDriftBps: 50,
    maxSpreadBps: 200,
    minDepthUsd: 1_000,
    minLiquidityUsd: 5_000,
    maxSizePerTradeUsd: 100,
    maxSizePerMarketUsd: 500,
    maxSizePerDayUsd: 2_000,
    stopCopyDrawdownPct: 0.10,
    stopCopyMinScore: 40,
    minShadowWindowDays: 7,
  },
  reconcileIntervalMs: 86_400_000,
  reconcileLookbackDays: 7,
  metadataCacheTtlMs: 3_600_000,
  telegramWebhookUrl: null,
  scanner: { ...DEFAULT_SCANNER_CONFIG },
};
