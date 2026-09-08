/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — Ingestion Pipeline
   Fetches whale trades from Polymarket CLOB API, de-duplicates, normalises,
   enriches with orderbook snapshots, and stores.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { logger } from '../reporting/logs';
import type { WhaleDB } from './whale_db';
import type { WhaleTrade, WhaleTrackingConfig, AggressorSide } from './whale_types';

/** Shape of a single trade from CLOB /trades endpoint */
interface ClobTrade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  /** Taker address */
  owner: string;
  /** Maker address */
  maker_address?: string;
  outcome?: string;
  type?: string;
}

/** CLOB orderbook snapshot shape */
interface OrderbookSnapshot {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

export class WhaleIngestion {
  private db: WhaleDB;
  private clobApi: string;
  private gammaApi: string;
  private config: WhaleTrackingConfig;
  private running = false;
  private isPolling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private requestTimestamps: number[] = [];
  private consecutiveErrors = 0;
  private maxConsecutiveErrors = 10;
  private marketMetadataCache: Map<string, { question: string; slug: string; outcomes: string[] }> = new Map();
  private metadataCacheLoadedAt = 0;

  constructor(db: WhaleDB, config: WhaleTrackingConfig, clobApi: string, gammaApi: string) {
    this.db = db;
    this.config = config;
    this.clobApi = clobApi;
    this.gammaApi = gammaApi;
  }

  /* ━━━━━━━━━━━━━━ Lifecycle ━━━━━━━━━━━━━━ */

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('WhaleIngestion started');
    // Immediately run, then schedule
    void this.pollCycle();
    this.pollTimer = setInterval(() => {
      void this.pollCycle();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    logger.info('WhaleIngestion stopped');
  }

  /* ━━━━━━━━━━━━━━ Poll cycle ━━━━━━━━━━━━━━ */

  private async pollCycle(): Promise<void> {
    if (!this.running || this.isPolling) return;
    this.isPolling = true;
    try {
      const { whales } = this.db.listWhales({ trackingEnabled: true, limit: 1000 });
      if (whales.length === 0) { return; }

      let newTradesTotal = 0;
      for (const whale of whales) {
        if (!this.running) break;
        await this.rateLimitWait();
        const newCount = await this.fetchWhaleTradesIncremental(whale.id, whale.address, whale.lastTradeCursor ?? undefined);
        newTradesTotal += newCount;
      }
      this.consecutiveErrors = 0;
      if (newTradesTotal > 0) {
        logger.info({ newTradesTotal, whaleCount: whales.length }, 'Ingestion poll complete');
      }
    } catch (err) {
      this.consecutiveErrors++;
      logger.error({ err, consecutiveErrors: this.consecutiveErrors }, 'Ingestion poll error');
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error('Too many consecutive errors, entering degraded mode — backing off');
        await this.sleep(60_000);
        this.consecutiveErrors = Math.floor(this.consecutiveErrors / 2);
      }
    } finally {
      this.isPolling = false;
    }
  }

  /* ━━━━━━━━━━━━━━ Incremental fetch ━━━━━━━━━━━━━━ */

  private async fetchWhaleTradesIncremental(
    whaleId: number,
    address: string,
    cursor?: string,
  ): Promise<number> {
    const trades = await this.fetchTradesFromClob(address, cursor);
    if (trades.length === 0) return 0;

    const newTrades: Omit<WhaleTrade, 'id'>[] = [];
    let latestCursor = cursor;

    for (const raw of trades) {
      const tradeId = raw.id;
      // Dedup: unique on (whale_id, trade_id)
      const existing = this.db.getTradeByTradeId(whaleId, tradeId);
      if (existing) continue;

      const price = parseFloat(raw.price);
      const size = parseFloat(raw.size);
      const notional = price * size;
      const feeRate = parseFloat(raw.fee_rate_bps || '0') / 10_000;
      const feeUsd = notional * feeRate;

      // Attempt orderbook snapshot for slippage estimation
      let midpoint: number | null = null;
      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      let slippageBps: number | null = null;

      // Only fetch orderbook if the trade is very recent (< 60s)
      const tradeAge = Date.now() - new Date(raw.match_time).getTime();
      if (tradeAge < 60_000 && notional >= 100) {
        try {
          await this.rateLimitWait();
          const book = await this.fetchOrderbook(raw.asset_id);
          if (book) {
            bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : null;
            bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : null;
            if (bestBid !== null && bestAsk !== null) {
              midpoint = (bestBid + bestAsk) / 2;
              if (midpoint > 0) {
                slippageBps = ((price - midpoint) / midpoint) * 10_000;
                if (raw.side === 'SELL') slippageBps = -slippageBps;
              }
            }
          }
        } catch {
          // Non-critical: continue without orderbook enrichment
        }
      }

      const aggressor: AggressorSide = this.classifyAggressor(raw);

      newTrades.push({
        whaleId,
        tradeId,
        logicalTradeGroupId: raw.taker_order_id || null,
        marketId: raw.market,
        outcome: raw.outcome || raw.asset_id,
        side: raw.side,
        price,
        size,
        notionalUsd: notional,
        feeUsd,
        isFeeEstimated: false,
        ts: raw.match_time,
        midpointAtFill: midpoint,
        bestBidAtFill: bestBid,
        bestAskAtFill: bestAsk,
        slippageBps,
        aggressor,
      });

      // Track the latest cursor (newest trade timestamp)
      if (!latestCursor || raw.match_time > latestCursor) {
        latestCursor = raw.match_time;
      }
    }

    if (newTrades.length > 0) {
      const inserted = this.db.insertTrades(newTrades);
      // Update whale cursor and last_active_at
      this.db.updateWhale(whaleId, {
        lastTradeCursor: latestCursor ?? undefined,
        lastActiveAt: new Date().toISOString(),
      });
      logger.debug({ whaleId, address: address.slice(0, 10) + '...', inserted }, 'Ingested whale trades');
      return inserted;
    }
    return 0;
  }

  /* ━━━━━━━━━━━━━━ Backfill ━━━━━━━━━━━━━━ */

  async backfillWhale(whaleId: number, address: string, maxPages = 50): Promise<number> {
    logger.info({ whaleId, address: address.slice(0, 10) + '...', maxPages }, 'Starting backfill');
    this.db.updateWhale(whaleId, { dataIntegrity: 'BACKFILLING' });

    let totalInserted = 0;
    let cursor: string | undefined;
    let page = 0;

    while (page < maxPages) {
      await this.rateLimitWait();
      const trades = await this.fetchTradesFromClob(address, cursor, 500);
      if (trades.length === 0) break;

      const newTrades: Omit<WhaleTrade, 'id'>[] = trades.map((raw) => {
        const price = parseFloat(raw.price);
        const size = parseFloat(raw.size);
        const notional = price * size;
        const feeRate = parseFloat(raw.fee_rate_bps || '0') / 10_000;
        return {
          whaleId,
          tradeId: raw.id,
          logicalTradeGroupId: raw.taker_order_id || null,
          marketId: raw.market,
          outcome: raw.outcome || raw.asset_id,
          side: raw.side,
          price,
          size,
          notionalUsd: notional,
          feeUsd: notional * feeRate,
          isFeeEstimated: false,
          ts: raw.match_time,
          midpointAtFill: null,
          bestBidAtFill: null,
          bestAskAtFill: null,
          slippageBps: null,
          aggressor: this.classifyAggressor(raw),
        };
      });

      const inserted = this.db.insertTrades(newTrades);
      totalInserted += inserted;

      // Oldest trade in this page becomes the next cursor (go backwards)
      const oldest = trades[trades.length - 1];
      cursor = oldest.match_time;
      page++;

      if (trades.length < 500) break; // No more pages
    }

    // Update whale metadata
    const allTrades = this.db.getWhaleTrades(whaleId, { limit: 1 });
    const latestCursor = allTrades.length > 0 ? allTrades[0].ts : undefined;
    this.db.updateWhale(whaleId, {
      dataIntegrity: 'HEALTHY',
      lastBackfillAt: new Date().toISOString(),
      lastTradeCursor: latestCursor,
    });

    logger.info({ whaleId, totalInserted, pages: page }, 'Backfill complete');
    return totalInserted;
  }

  /* ━━━━━━━━━━━━━━ CLOB API helpers ━━━━━━━━━━━━━━ */

  private async fetchTradesFromClob(
    address: string,
    after?: string,
    limit = 100,
  ): Promise<ClobTrade[]> {
    let url = `${this.clobApi}/trades?maker_address=${address}&limit=${limit}`;
    if (after) url += `&after=${encodeURIComponent(after)}`;

    this.recordRequest();
    const res = await this.fetchWithRetry(url);
    if (!res) return [];
    const data = await res.json() as ClobTrade[] | { trades?: ClobTrade[] };
    return Array.isArray(data) ? data : (data.trades ?? []);
  }

  private async fetchOrderbook(tokenId: string): Promise<OrderbookSnapshot | null> {
    const url = `${this.clobApi}/book?token_id=${tokenId}`;
    this.recordRequest();
    const res = await this.fetchWithRetry(url);
    if (!res) return null;
    return await res.json() as OrderbookSnapshot;
  }

  /** Fetch market metadata from Gamma for enrichment */
  async refreshMarketMetadata(): Promise<void> {
    // Only refresh every metadataCacheTtlMs
    const now = Date.now();
    if (now - this.metadataCacheLoadedAt < (this.config.metadataCacheTtlMs ?? 300_000)) return;

    try {
      await this.rateLimitWait();
      const url = `${this.gammaApi}/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false`;
      const res = await this.fetchWithRetry(url);
      if (!res) return;
      const markets = await res.json() as Array<{ id: string; question: string; slug: string; outcomes: string }>;
      this.marketMetadataCache.clear();
      for (const m of markets) {
        this.marketMetadataCache.set(m.id, {
          question: m.question,
          slug: m.slug,
          outcomes: JSON.parse(m.outcomes || '[]'),
        });
      }
      this.metadataCacheLoadedAt = now;
      logger.debug({ count: this.marketMetadataCache.size }, 'Refreshed market metadata cache');
    } catch (err) {
      logger.warn({ err }, 'Failed to refresh market metadata');
    }
  }

  getMarketMeta(marketId: string): { question: string; slug: string; outcomes: string[] } | undefined {
    return this.marketMetadataCache.get(marketId);
  }

  /* ━━━━━━━━━━━━━━ Rate limiting ━━━━━━━━━━━━━━ */

  private recordRequest(): void {
    this.requestTimestamps.push(Date.now());
    // Trim old entries
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
  }

  private async rateLimitWait(): Promise<void> {
    const maxReq = this.config.maxRequestsPerMinute;
    const cutoff = Date.now() - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter((t) => t >= cutoff);
    if (this.requestTimestamps.length >= maxReq) {
      const oldest = this.requestTimestamps[0];
      const waitMs = oldest + 60_000 - Date.now() + 100; // +100ms buffer
      if (waitMs > 0) {
        logger.debug({ waitMs }, 'Rate limit: waiting');
        await this.sleep(waitMs);
      }
    }
  }

  /* ━━━━━━━━━━━━━━ Fetch with retry + exponential backoff ━━━━━━━━━━━━━━ */

  private async fetchWithRetry(url: string, maxRetries = 3): Promise<Response | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) return res;
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
          logger.warn({ retryAfter, attempt }, 'Rate limited, backing off');
          await this.sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500) {
          logger.warn({ status: res.status, attempt }, 'Server error, retrying');
          await this.sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        // 4xx (non-429) — don't retry
        logger.error({ status: res.status, url: url.replace(/maker_address=0x[a-fA-F0-9]+/, 'maker_address=REDACTED') }, 'CLOB request failed');
        return null;
      } catch (err) {
        if (attempt === maxRetries) {
          logger.error({ err, attempt }, 'Fetch failed after retries');
          return null;
        }
        await this.sleep(Math.pow(2, attempt) * 1000);
      }
    }
    return null;
  }

  /* ━━━━━━━━━━━━━━ Helpers ━━━━━━━━━━━━━━ */

  private classifyAggressor(raw: ClobTrade): AggressorSide {
    // Simple heuristic: the taker is the aggressor
    // If the trade type indicates market vs limit, use that
    if (raw.type === 'GTC' || raw.type === 'GTD') return 'UNKNOWN'; // limit order
    return raw.side; // taker side = aggressor
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
