/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Service Orchestrator
   Initialises all whale sub-systems, manages lifecycle,
   exposes a unified API for the dashboard and CLI.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import { WhaleDB } from './whale_db';
import { WhaleIngestion } from './whale_ingestion';
import { WhaleAnalytics } from './whale_analytics';
import { WhaleAlerts } from './whale_alerts';
import { WhaleCandidates } from './whale_candidates';
import { ShadowPortfolioManager } from './shadow_portfolio';
import { WhaleReconciliation } from './whale_reconciliation';
import { WhaleScanner } from './whale_scanner';
import type {
  WhaleTrackingConfig, Whale, WhaleTrade, WhalePosition,
  WhaleScoreBreakdown, TimingWindow, WhaleCandidate,
  Alert, Signal as WhaleSignal, Watchlist,
  ShadowPortfolio, WhaleMetricsDaily,
  WhaleListItem, WhaleDetailResponse, MarketWhaleActivity,
  ScannerState, ScannedWhaleProfile, WhaleCluster,
  ClusterSignal, WhaleNetworkGraph, CopySimResult, RegimeState,
} from './whale_types';
import type { ReconciliationReport } from './whale_reconciliation';

export class WhaleService {
  private db!: WhaleDB;
  private ingestion!: WhaleIngestion;
  private analytics!: WhaleAnalytics;
  private alerts!: WhaleAlerts;
  private candidates!: WhaleCandidates;
  private shadow!: ShadowPortfolioManager;
  private reconciliation!: WhaleReconciliation;
  private scanner!: WhaleScanner;
  private config: WhaleTrackingConfig;
  private clobApi: string;
  private gammaApi: string;
  private analyticsTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: WhaleTrackingConfig, clobApi: string, gammaApi: string) {
    this.config = config;
    this.clobApi = clobApi;
    this.gammaApi = gammaApi;
  }

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  start(): void {
    if (this.running) return;
    this.running = true;

    // Init DB
    this.db = new WhaleDB(this.config.dbPath);

    // Init sub-systems
    this.ingestion = new WhaleIngestion(this.db, this.config, this.clobApi, this.gammaApi);
    this.analytics = new WhaleAnalytics(this.db, this.config);
    this.alerts = new WhaleAlerts(this.db, this.config);
    this.candidates = new WhaleCandidates(this.db, this.config, this.clobApi);
    this.shadow = new ShadowPortfolioManager(this.db, this.config);
    this.reconciliation = new WhaleReconciliation(this.db, this.config, this.ingestion);
    this.scanner = new WhaleScanner(this.db, this.config, this.gammaApi, this.clobApi);

    // Start background services
    this.ingestion.start();
    this.candidates.start();
    this.reconciliation.start();

    // Auto-start scanner if configured
    if (this.config.scanner.enabled) {
      this.scanner.start();
    }

    // Analytics refresh every 5 minutes
    this.analyticsTimer = setInterval(() => {
      void this.refreshAllAnalytics();
    }, 300_000);

    logger.info('WhaleService started — all sub-systems active');
  }

  stop(): void {
    this.running = false;
    this.ingestion?.stop();
    this.candidates?.stop();
    this.reconciliation?.stop();
    this.scanner?.stop();
    if (this.analyticsTimer) { clearInterval(this.analyticsTimer); this.analyticsTimer = null; }
    this.db?.close();
    logger.info('WhaleService stopped');
  }

  isRunning(): boolean { return this.running; }

  /* ━━━━━━━━━━━━━━ Whale management ━━━━━━━━━━━━━━ */

  addWhale(address: string, opts?: { displayName?: string; tags?: string[]; notes?: string }): Whale {
    const whale = this.db.addWhale(address, opts);
    // Trigger backfill
    void this.ingestion.backfillWhale(whale.id, whale.address);
    return whale;
  }

  getWhale(id: number): Whale | undefined {
    return this.db.getWhale(id);
  }

  getWhaleByAddress(address: string): Whale | undefined {
    return this.db.getWhaleByAddress(address);
  }

  listWhales(opts?: {
    starred?: boolean;
    trackingEnabled?: boolean;
    style?: string;
    tag?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
  }): { whales: WhaleListItem[]; total: number } {
    const result = this.db.listWhales(opts);
    const enriched: WhaleListItem[] = result.whales.map((w) => this.enrichWhaleListItem(w));
    return { whales: enriched, total: result.total };
  }

  updateWhale(id: number, updates: Partial<Pick<Whale, 'displayName' | 'starred' | 'trackingEnabled' | 'tags' | 'notes' | 'copyMode'>>): void {
    this.db.updateWhale(id, updates);
  }

  deleteWhale(id: number): void {
    this.db.deleteWhale(id);
  }

  /* ━━━━━━━━━━━━━━ Whale detail ━━━━━━━━━━━━━━ */

  getWhaleDetail(id: number): WhaleDetailResponse | null {
    const whale = this.db.getWhale(id);
    if (!whale) return null;

    const scoreBreakdown = this.analytics.computeScore(id);
    const equityCurve = this.analytics.getEquityCurve(id);
    const recentTrades = this.db.getWhaleTrades(id, { limit: 50 });
    const openPositions = this.db.getPositions(id);
    const timingAnalysis = this.analytics.computeTimingAnalysis(id);

    // Category distribution from trades
    const categoryDistribution = this.computeCategoryDistribution(id);

    return {
      whale,
      scoreBreakdown,
      equityCurve,
      recentTrades,
      openPositions,
      categoryDistribution,
      timingAnalysis,
    };
  }

  /* ━━━━━━━━━━━━━━ Trades ━━━━━━━━━━━━━━ */

  getWhaleTrades(whaleId: number, opts?: { limit?: number; cursor?: string; marketId?: string }): WhaleTrade[] {
    return this.db.getWhaleTrades(whaleId, opts);
  }

  /* ━━━━━━━━━━━━━━ Positions ━━━━━━━━━━━━━━ */

  getWhalePositions(whaleId: number): WhalePosition[] {
    return this.db.getPositions(whaleId);
  }

  /* ━━━━━━━━━━━━━━ Score + analytics ━━━━━━━━━━━━━━ */

  getWhaleScore(whaleId: number): WhaleScoreBreakdown {
    return this.analytics.computeScore(whaleId);
  }

  getTimingAnalysis(whaleId: number): TimingWindow[] {
    return this.analytics.computeTimingAnalysis(whaleId);
  }

  getDailyMetrics(whaleId: number, fromDate?: string, toDate?: string): WhaleMetricsDaily[] {
    return this.db.getDailyMetrics(whaleId, { fromDate, toDate });
  }

  /* ━━━━━━━━━━━━━━ Alerts ━━━━━━━━━━━━━━ */

  getAlerts(opts?: { whaleId?: number; unreadOnly?: boolean; limit?: number; cursor?: string }): Alert[] {
    return this.db.listAlerts(opts);
  }

  markAlertRead(id: number): void {
    this.db.markAlertRead(id);
  }

  markAllAlertsRead(whaleId?: number): void {
    this.db.markAllAlertsRead(whaleId);
  }

  getUnreadAlertCount(): number {
    return this.db.getUnreadAlertCount();
  }

  /* ━━━━━━━━━━━━━━ Signals ━━━━━━━━━━━━━━ */

  getSignals(opts?: { limit?: number; cursor?: string }): WhaleSignal[] {
    return this.db.listSignals(opts);
  }

  /* ━━━━━━━━━━━━━━ Candidates ━━━━━━━━━━━━━━ */

  listCandidates(opts?: { limit?: number; offset?: number }): WhaleCandidate[] {
    return this.db.listCandidates(opts);
  }

  approveCandidate(address: string): Whale {
    this.db.approveCandidate(address);
    return this.addWhale(address, { notes: 'Promoted from candidate pool' });
  }

  muteCandidate(address: string, days?: number): void {
    this.db.muteCandidate(address, days);
  }

  /* ━━━━━━━━━━━━━━ Watchlists ━━━━━━━━━━━━━━ */

  createWatchlist(name: string): Watchlist {
    return this.db.createWatchlist(name);
  }

  listWatchlists(): Watchlist[] {
    return this.db.listWatchlists();
  }

  deleteWatchlist(id: number): void {
    this.db.deleteWatchlist(id);
  }

  addToWatchlist(watchlistId: number, whaleId: number): void {
    this.db.addToWatchlist(watchlistId, whaleId);
  }

  removeFromWatchlist(watchlistId: number, whaleId: number): void {
    this.db.removeFromWatchlist(watchlistId, whaleId);
  }

  getWatchlistItems(watchlistId: number): WhaleListItem[] {
    const whales = this.db.getWatchlistItems(watchlistId);
    return whales.map((w) => this.enrichWhaleListItem(w));
  }

  /* ━━━━━━━━━━━━━━ Shadow portfolios ━━━━━━━━━━━━━━ */

  getShadowPortfolio(whaleId: number): ShadowPortfolio | undefined {
    return this.db.getShadowPortfolio(whaleId);
  }

  /* ━━━━━━━━━━━━━━ Market whale activity ━━━━━━━━━━━━━━ */

  getMarketWhaleActivity(marketId: string): MarketWhaleActivity {
    const trades = this.db.getMarketTrades(marketId, { limit: 500 });

    // Net flow by outcome
    const flowMap = new Map<string, number>();
    for (const t of trades) {
      const current = flowMap.get(t.outcome) ?? 0;
      flowMap.set(t.outcome, current + (t.side === 'BUY' ? t.notionalUsd : -t.notionalUsd));
    }
    const whaleNetFlow = Array.from(flowMap.entries()).map(([outcome, netUsd]) => ({ outcome, netUsd }));

    // Biggest prints
    const biggestPrints = [...trades].sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 10);

    // Concentration
    const whaleVol = new Map<number, { address: string; vol: number }>();
    const totalVol = trades.reduce((s, t) => s + t.notionalUsd, 0);
    for (const t of trades) {
      const current = whaleVol.get(t.whaleId) ?? { address: '', vol: 0 };
      current.vol += t.notionalUsd;
      whaleVol.set(t.whaleId, current);
    }
    // Enrich with addresses
    for (const [whaleId, data] of whaleVol) {
      const whale = this.db.getWhale(whaleId);
      if (whale) data.address = whale.address;
    }
    const concentration = Array.from(whaleVol.entries())
      .map(([whaleId, data]) => ({
        whaleId,
        address: data.address,
        pct: totalVol > 0 ? data.vol / totalVol : 0,
      }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10);

    // Recent entries / exits
    const recentEntries = trades.filter((t) => t.side === 'BUY').slice(0, 10);
    const recentExits = trades.filter((t) => t.side === 'SELL').slice(0, 10);

    return { marketId, whaleNetFlow, biggestPrints, concentration, recentEntries, recentExits };
  }

  /* ━━━━━━━━━━━━━━ Scanner ━━━━━━━━━━━━━━ */

  getScannerState(): ScannerState {
    return this.scanner.getState();
  }

  getScannerResults(): ScannedWhaleProfile[] {
    return this.scanner.getResults();
  }

  getScannerClusters(): WhaleCluster[] {
    return this.scanner.getClusters();
  }

  getScannerProfile(address: string): ScannedWhaleProfile | undefined {
    return this.scanner.getProfile(address);
  }

  startScanner(): void {
    this.scanner.start();
  }

  stopScanner(): void {
    this.scanner.stop();
  }

  toggleScanner(): boolean {
    return this.scanner.toggle();
  }

  async triggerScan(): Promise<ScannedWhaleProfile[]> {
    return this.scanner.triggerScan();
  }

  promoteScannedWhale(address: string): Whale {
    return this.addWhale(address, {
      tags: ['scanner_discovered'],
      notes: 'Promoted from scanner results',
    });
  }

  /* ━━━━━━━━━━━━━━ Scanner — Advanced Features ━━━━━━━━━━━━━━ */

  getClusterSignals(): ClusterSignal[] {
    return this.scanner.getClusterSignals();
  }

  getNetworkGraph(): WhaleNetworkGraph | null {
    return this.scanner.getNetworkGraph();
  }

  getCopySimResults(): CopySimResult[] {
    return this.scanner.getCopySimResults();
  }

  getCopySimResult(address: string): CopySimResult | undefined {
    return this.scanner.getCopySimResult(address);
  }

  getRegimeState(): RegimeState | null {
    return this.scanner.getRegimeState();
  }

  getApiPoolStatus(): ReturnType<typeof this.scanner.getApiPoolStatus> {
    return this.scanner.getApiPoolStatus();
  }

  getWalletBalance(address: string): number | undefined {
    return this.scanner.getWalletBalance(address);
  }

  /* ━━━━━━━━━━━━━━ Reconciliation ━━━━━━━━━━━━━━ */

  async runReconciliation(): Promise<ReconciliationReport[]> {
    return this.reconciliation.reconcileCycle();
  }

  /* ━━━━━━━━━━━━━━ Comparison ━━━━━━━━━━━━━━ */

  compareWhales(ids: number[]): Array<{
    whale: Whale;
    score: WhaleScoreBreakdown;
    stats: {
      totalVolume: number;
      tradeCount: number;
      winRate: number;
      settledPnl: number;
      distinctMarkets: number;
    };
  }> {
    return ids.map((id) => {
      const whale = this.db.getWhale(id);
      if (!whale) return null;
      const score = this.analytics.computeScore(id);
      return {
        whale,
        score,
        stats: {
          totalVolume: this.db.getWhaleVolume(id),
          tradeCount: this.db.getWhaleTradeCount(id),
          winRate: this.db.getWinRate(id),
          settledPnl: this.db.getSettledPnl(id),
          distinctMarkets: this.db.getWhaleDistinctMarkets(id),
        },
      };
    }).filter(Boolean) as Array<{
      whale: Whale;
      score: WhaleScoreBreakdown;
      stats: {
        totalVolume: number;
        tradeCount: number;
        winRate: number;
        settledPnl: number;
        distinctMarkets: number;
      };
    }>;
  }

  /* ━━━━━━━━━━━━━━ Summary for dashboard ━━━━━━━━━━━━━━ */

  getSummary(): {
    totalWhales: number;
    trackedWhales: number;
    unreadAlerts: number;
    candidateCount: number;
    totalTradesIngested: number;
    serviceRunning: boolean;
    scannerEnabled: boolean;
    scannerStatus: string;
  } {
    const { total: totalWhales } = this.db.listWhales({ limit: 0 });
    const { total: trackedWhales } = this.db.listWhales({ trackingEnabled: true, limit: 0 });
    const unreadAlerts = this.db.getUnreadAlertCount();
    const candidates = this.db.listCandidates({ limit: 0 });
    const scannerState = this.scanner?.getState();
    return {
      totalWhales,
      trackedWhales,
      unreadAlerts,
      candidateCount: candidates.length,
      totalTradesIngested: 0, // Could be tracked with a counter
      serviceRunning: this.running,
      scannerEnabled: scannerState?.enabled ?? false,
      scannerStatus: scannerState?.status ?? 'idle',
    };
  }

  /* ━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━ */

  private async refreshAllAnalytics(): Promise<void> {
    if (!this.running) return;
    try {
      const { whales } = this.db.listWhales({ trackingEnabled: true, limit: 1000 });
      for (const whale of whales) {
        if (!this.running) break;
        this.analytics.computeAllMetrics(whale.id);
      }
    } catch (err) {
      logger.error({ err }, 'Analytics refresh error');
    }
  }

  private enrichWhaleListItem(w: Whale): WhaleListItem {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const tradeCount = this.db.getWhaleTradeCount(w.id);
    const volume = this.db.getWhaleVolume(w.id);
    const volume30d = this.db.getWhaleVolume(w.id, thirtyDaysAgo);
    const markets30d = this.db.getWhaleDistinctMarkets(w.id, thirtyDaysAgo);
    const marketsLifetime = this.db.getWhaleDistinctMarkets(w.id);
    const settledPnl = this.db.getSettledPnl(w.id);
    const settledPnl30d = this.db.getSettledPnl(w.id, thirtyDaysAgo);
    const winRate = this.db.getWinRate(w.id);
    const metrics = this.db.getDailyMetrics(w.id, { fromDate: thirtyDaysAgo });
    const avgHold = metrics.length > 0
      ? metrics.reduce((s, m) => s + m.avgHoldMinutes, 0) / metrics.length
      : 0;
    const avgSlippage = metrics.length > 0
      ? metrics.reduce((s, m) => s + m.avgSlippageBps, 0) / metrics.length
      : 0;
    const consistency = metrics.length > 0
      ? metrics.reduce((s, m) => s + m.consistencyScore, 0) / metrics.length
      : 0;
    const whaleScore = metrics.length > 0 ? metrics[metrics.length - 1].score : 0;

    return {
      ...w,
      marketsTraded30d: markets30d,
      marketsTraded_lifetime: marketsLifetime,
      totalVolume30d: volume30d,
      totalVolume_lifetime: volume,
      realizedPnl30d: settledPnl30d,
      realizedPnl_lifetime: settledPnl,
      unrealizedPnl: 0, // Requires mark-to-market
      winRate,
      avgHoldMinutes: avgHold,
      avgSlippageBps: avgSlippage,
      consistencyScore: consistency,
      whaleScore,
      scoreProvisional: tradeCount < this.config.provisionalMinTrades,
    };
  }

  private computeCategoryDistribution(whaleId: number): { category: string; count: number; volumeUsd: number }[] {
    const trades = this.db.getWhaleTrades(whaleId, { limit: 10000 });
    const byMarket = new Map<string, { count: number; volumeUsd: number }>();

    for (const t of trades) {
      const existing = byMarket.get(t.marketId) ?? { count: 0, volumeUsd: 0 };
      existing.count++;
      existing.volumeUsd += t.notionalUsd;
      byMarket.set(t.marketId, existing);
    }

    // Use marketId as category (in production, would map via metadata)
    return Array.from(byMarket.entries())
      .map(([category, data]) => ({
        category: this.ingestion.getMarketMeta(category)?.slug ?? category.slice(0, 12),
        count: data.count,
        volumeUsd: data.volumeUsd,
      }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd)
      .slice(0, 20);
  }
}
