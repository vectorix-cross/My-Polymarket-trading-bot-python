/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Candidate Discovery
   Scans CLOB trades to auto-discover addresses with whale-level activity.
   Ranks candidates by volume, frequency, and breadth.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type { WhaleTrackingConfig } from './whale_types';

interface ClobTradeScan {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  match_time: string;
  owner: string;
  maker_address?: string;
}

export class WhaleCandidates {
  private db: WhaleDB;
  private config: WhaleTrackingConfig;
  private clobApi: string;
  private running = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: WhaleDB, config: WhaleTrackingConfig, clobApi: string) {
    this.db = db;
    this.config = config;
    this.clobApi = clobApi;
  }

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('WhaleCandidates discovery started');
    // Run immediately then on interval
    void this.scanCycle();
    this.scanTimer = setInterval(() => {
      void this.scanCycle();
    }, this.config.candidateScanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    logger.info('WhaleCandidates discovery stopped');
  }

  /* ━━━━━━━━━━━━━━ Main scan cycle ━━━━━━━━━━━━━━ */

  private async scanCycle(): Promise<void> {
    if (!this.running) return;
    try {
      // Fetch recent trades from CLOB (high-volume markets)
      const trades = await this.fetchRecentTrades();
      if (trades.length === 0) return;

      // Aggregate by address
      const addressStats = this.aggregateByAddress(trades);

      // Filter candidates meeting thresholds
      const existingWhales = this.db.listWhales({ limit: 10000 });
      const existingAddresses = new Set(existingWhales.whales.map((w) => w.address.toLowerCase()));

      let candidatesUpserted = 0;
      for (const [address, stats] of addressStats) {
        // Skip already tracked whales
        if (existingAddresses.has(address)) continue;

        // Apply minimum thresholds
        if (stats.volumeUsd24h < this.config.candidateMinVolumeUsd24h) continue;
        if (stats.trades24h < this.config.candidateMinTrades24h) continue;

        // Compute rank score (0-100)
        const rankScore = this.computeRankScore(stats);

        // Suggest tags based on behaviour
        const suggestedTags = this.suggestTags(stats);

        this.db.upsertCandidate({
          address,
          firstSeenAt: stats.firstSeen,
          lastSeenAt: stats.lastSeen,
          volumeUsd24h: stats.volumeUsd24h,
          trades24h: stats.trades24h,
          maxSingleTradeUsd: stats.maxSingleTradeUsd,
          markets7d: stats.distinctMarkets,
          rankScore,
          suggestedTags,
          mutedUntil: null,
          approved: false,
        });
        candidatesUpserted++;
      }

      if (candidatesUpserted > 0) {
        logger.info({ candidatesUpserted }, 'Whale candidate scan complete');
      }

      // Auto-track top K if configured
      if (this.config.candidateAutoTrackTopK > 0) {
        await this.autoTrackTopCandidates();
      }
    } catch (err) {
      logger.error({ err }, 'Whale candidate scan error');
    }
  }

  /* ━━━━━━━━━━━━━━ Fetch recent trades ━━━━━━━━━━━━━━ */

  private async fetchRecentTrades(): Promise<ClobTradeScan[]> {
    /* Primary: CLOB API */
    try {
      const url = `${this.clobApi}/trades?limit=500`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as ClobTradeScan[] | { trades?: ClobTradeScan[] };
        return Array.isArray(data) ? data : (data.trades ?? []);
      }
      /* CLOB auth failed (401) or other error — fall through to data-api */
      logger.debug({ status: res.status }, 'CLOB trades unavailable, falling back to data-api');
    } catch {
      logger.debug('CLOB trades fetch error, falling back to data-api');
    }

    /* Fallback: Polymarket data-api (public, no auth required) */
    return this.fetchFromDataApi();
  }

  /**
   * Fallback: fetch recent trades from the public data-api.
   * Scans the top 5 highest-volume markets for recent activity.
   */
  private async fetchFromDataApi(): Promise<ClobTradeScan[]> {
    const dataApi = 'https://data-api.polymarket.com';
    const gammaApi = this.clobApi.replace('clob.polymarket.com', 'gamma-api.polymarket.com');

    try {
      /* Fetch top liquid markets from Gamma */
      const marketsRes = await fetch(
        `${gammaApi}/markets?active=true&closed=false&limit=10&order=volume24hr&ascending=false`,
      );
      if (!marketsRes.ok) return [];

      interface GammaMarketSlim {
        conditionId?: string;
        volume24hr?: number;
      }

      const markets: GammaMarketSlim[] = await marketsRes.json() as GammaMarketSlim[];
      const allTrades: ClobTradeScan[] = [];

      for (const m of markets.slice(0, 5)) {
        if (!m.conditionId) continue;
        try {
          const tradesRes = await fetch(`${dataApi}/trades?market=${m.conditionId}&limit=200`);
          if (!tradesRes.ok) continue;

          interface DataApiTrade {
            transactionHash?: string;
            proxyWallet?: string;
            side?: string;
            size?: number | string;
            price?: number | string;
            timestamp?: number;
            asset?: string;
          }

          const raw: DataApiTrade[] = await tradesRes.json() as DataApiTrade[];
          if (!Array.isArray(raw)) continue;

          for (const t of raw) {
            if (!t.proxyWallet || !t.side || t.size == null || t.price == null) continue;
            allTrades.push({
              id: t.transactionHash ?? '',
              market: m.conditionId!,
              asset_id: t.asset ?? '',
              side: (t.side?.toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
              size: String(t.size),
              price: String(t.price),
              match_time: t.timestamp
                ? new Date(t.timestamp * 1000).toISOString()
                : new Date().toISOString(),
              owner: t.proxyWallet,
            });
          }
        } catch {
          /* Non-critical: skip this market */
        }
      }

      if (allTrades.length > 0) {
        logger.info({ trades: allTrades.length }, 'Candidate scan: fetched trades via data-api fallback');
      }
      return allTrades;
    } catch (err) {
      logger.warn({ err }, 'Candidate scan: data-api fallback error');
      return [];
    }
  }

  /* ━━━━━━━━━━━━━━ Aggregation ━━━━━━━━━━━━━━ */

  private aggregateByAddress(trades: ClobTradeScan[]): Map<string, {
    volumeUsd24h: number;
    trades24h: number;
    maxSingleTradeUsd: number;
    distinctMarkets: number;
    firstSeen: string;
    lastSeen: string;
    buySellRatio: number;
    avgTradeSize: number;
  }> {
    const stats = new Map<string, {
      volumeUsd24h: number;
      trades24h: number;
      maxSingleTradeUsd: number;
      markets: Set<string>;
      firstSeen: string;
      lastSeen: string;
      buys: number;
      sells: number;
      totalNotional: number;
    }>();

    for (const t of trades) {
      // Process both owner (taker) and maker_address
      const addresses = [t.owner];
      if (t.maker_address) addresses.push(t.maker_address);

      for (const rawAddr of addresses) {
        if (!rawAddr) continue;
        const addr = rawAddr.toLowerCase();
        const notional = parseFloat(t.price) * parseFloat(t.size);

        if (!stats.has(addr)) {
          stats.set(addr, {
            volumeUsd24h: 0,
            trades24h: 0,
            maxSingleTradeUsd: 0,
            markets: new Set(),
            firstSeen: t.match_time,
            lastSeen: t.match_time,
            buys: 0,
            sells: 0,
            totalNotional: 0,
          });
        }

        const s = stats.get(addr)!;
        s.volumeUsd24h += notional;
        s.trades24h++;
        s.maxSingleTradeUsd = Math.max(s.maxSingleTradeUsd, notional);
        s.markets.add(t.market);
        if (t.match_time < s.firstSeen) s.firstSeen = t.match_time;
        if (t.match_time > s.lastSeen) s.lastSeen = t.match_time;
        if (t.side === 'BUY') s.buys++; else s.sells++;
        s.totalNotional += notional;
      }
    }

    // Convert to return format
    const result = new Map<string, {
      volumeUsd24h: number;
      trades24h: number;
      maxSingleTradeUsd: number;
      distinctMarkets: number;
      firstSeen: string;
      lastSeen: string;
      buySellRatio: number;
      avgTradeSize: number;
    }>();

    for (const [addr, s] of stats) {
      result.set(addr, {
        volumeUsd24h: s.volumeUsd24h,
        trades24h: s.trades24h,
        maxSingleTradeUsd: s.maxSingleTradeUsd,
        distinctMarkets: s.markets.size,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        buySellRatio: s.sells > 0 ? s.buys / s.sells : s.buys,
        avgTradeSize: s.trades24h > 0 ? s.totalNotional / s.trades24h : 0,
      });
    }

    return result;
  }

  /* ━━━━━━━━━━━━━━ Rank scoring ━━━━━━━━━━━━━━ */

  private computeRankScore(stats: {
    volumeUsd24h: number;
    trades24h: number;
    maxSingleTradeUsd: number;
    distinctMarkets: number;
    avgTradeSize: number;
  }): number {
    // Combine multiple signals into a 0-100 rank
    let score = 0;

    // Volume component (0-40): $10k = 10, $100k = 30, $1M+ = 40
    score += Math.min(40, Math.log10(Math.max(stats.volumeUsd24h, 1)) / Math.log10(1_000_000) * 40);

    // Trade frequency (0-20)
    score += Math.min(20, stats.trades24h / 50 * 20);

    // Max single trade size (0-20): indicator of conviction
    score += Math.min(20, Math.log10(Math.max(stats.maxSingleTradeUsd, 1)) / Math.log10(100_000) * 20);

    // Market diversity (0-20)
    score += Math.min(20, stats.distinctMarkets / 10 * 20);

    return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
  }

  /* ━━━━━━━━━━━━━━ Tag suggestions ━━━━━━━━━━━━━━ */

  private suggestTags(stats: {
    volumeUsd24h: number;
    avgTradeSize: number;
    buySellRatio: number;
    distinctMarkets: number;
  }): string[] {
    const tags: string[] = [];

    if (stats.volumeUsd24h > 100_000) tags.push('high_volume');
    if (stats.avgTradeSize > 5_000) tags.push('large_trades');
    if (stats.buySellRatio > 3) tags.push('aggressive_buyer');
    if (stats.buySellRatio < 0.33) tags.push('aggressive_seller');
    if (stats.distinctMarkets > 10) tags.push('diversified');
    if (stats.distinctMarkets === 1) tags.push('concentrated');

    return tags;
  }

  /* ━━━━━━━━━━━━━━ Auto-track ━━━━━━━━━━━━━━ */

  private async autoTrackTopCandidates(): Promise<void> {
    const topK = this.config.candidateAutoTrackTopK;
    if (topK <= 0) return;

    const candidates = this.db.listCandidates({
      limit: topK,
      excludeApproved: true,
      excludeMuted: true,
    });

    for (const c of candidates) {
      if (c.rankScore >= 60) {
        // Auto-promote to tracked whale
        this.db.approveCandidate(c.address);
        this.db.addWhale(c.address, {
          tags: c.suggestedTags,
          notes: `Auto-discovered. Rank score: ${c.rankScore}`,
        });
        logger.info({ address: c.address.slice(0, 10) + '...', rankScore: c.rankScore }, 'Auto-tracked whale candidate');
      }
    }
  }
}
