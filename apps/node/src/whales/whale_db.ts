/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — SQLite Database Layer
   Uses better-sqlite3 (synchronous, production-grade).
   Schema is Postgres-ready (standard SQL types, no SQLite-only features).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../reporting/logs';
import type {
  Whale, WhaleTrade, WhalePosition, WhaleMetricsDaily,
  SettlementLedgerEntry, WhaleCandidate, Alert, Signal as WhaleSignal,
  Watchlist, ShadowPortfolio, ShadowPosition,
  AggressorSide, AlertType,
} from './whale_types';

export class WhaleDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    logger.info({ dbPath }, 'WhaleDB initialised');
  }

  close(): void { this.db.close(); }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     MIGRATIONS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whales (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        address       TEXT    NOT NULL UNIQUE,
        display_name  TEXT,
        starred       INTEGER NOT NULL DEFAULT 0,
        tracking_enabled INTEGER NOT NULL DEFAULT 1,
        tags          TEXT    NOT NULL DEFAULT '[]',
        notes         TEXT    NOT NULL DEFAULT '',
        style         TEXT    NOT NULL DEFAULT 'UNKNOWN',
        data_integrity TEXT   NOT NULL DEFAULT 'BACKFILLING',
        copy_mode     TEXT    NOT NULL DEFAULT 'ALERTS_ONLY',
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT,
        last_backfill_at TEXT,
        last_trade_cursor TEXT
      );

      CREATE TABLE IF NOT EXISTS whale_trades (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id             INTEGER NOT NULL REFERENCES whales(id),
        trade_id             TEXT,
        logical_trade_group_id TEXT,
        market_id            TEXT    NOT NULL,
        outcome              TEXT    NOT NULL,
        side                 TEXT    NOT NULL,
        price                REAL    NOT NULL,
        size                 REAL    NOT NULL,
        notional_usd         REAL    NOT NULL,
        fee_usd              REAL    NOT NULL DEFAULT 0,
        is_fee_estimated     INTEGER NOT NULL DEFAULT 1,
        ts                   TEXT    NOT NULL,
        midpoint_at_fill     REAL,
        best_bid_at_fill     REAL,
        best_ask_at_fill     REAL,
        slippage_bps         REAL,
        aggressor            TEXT    NOT NULL DEFAULT 'UNKNOWN',
        UNIQUE(whale_id, trade_id)
      );

      CREATE TABLE IF NOT EXISTS whale_positions (
        whale_id        INTEGER NOT NULL REFERENCES whales(id),
        market_id       TEXT    NOT NULL,
        outcome         TEXT    NOT NULL,
        net_shares      REAL    NOT NULL DEFAULT 0,
        avg_entry_price REAL    NOT NULL DEFAULT 0,
        cost_basis      REAL    NOT NULL DEFAULT 0,
        unrealized_pnl  REAL    NOT NULL DEFAULT 0,
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (whale_id, market_id, outcome)
      );

      CREATE TABLE IF NOT EXISTS whale_metrics_daily (
        whale_id               INTEGER NOT NULL REFERENCES whales(id),
        date                   TEXT    NOT NULL,
        realized_pnl           REAL    NOT NULL DEFAULT 0,
        unrealized_pnl         REAL    NOT NULL DEFAULT 0,
        volume_usd             REAL    NOT NULL DEFAULT 0,
        trades_count           INTEGER NOT NULL DEFAULT 0,
        win_rate               REAL    NOT NULL DEFAULT 0,
        avg_slippage_bps       REAL    NOT NULL DEFAULT 0,
        avg_hold_minutes       REAL    NOT NULL DEFAULT 0,
        timing_score           REAL    NOT NULL DEFAULT 0,
        consistency_score      REAL    NOT NULL DEFAULT 0,
        market_selection_score REAL    NOT NULL DEFAULT 0,
        score                  REAL    NOT NULL DEFAULT 0,
        score_confidence       REAL    NOT NULL DEFAULT 0,
        score_version          TEXT    NOT NULL DEFAULT '1.0.0',
        PRIMARY KEY (whale_id, date)
      );

      CREATE TABLE IF NOT EXISTS whale_settlement_ledger (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id                 INTEGER NOT NULL REFERENCES whales(id),
        market_id                TEXT    NOT NULL,
        outcome                  TEXT    NOT NULL,
        lot_id                   TEXT    NOT NULL,
        open_ts                  TEXT    NOT NULL,
        close_ts                 TEXT,
        qty                      REAL    NOT NULL,
        entry_price              REAL    NOT NULL,
        exit_price_or_settlement REAL,
        realized_pnl             REAL    NOT NULL DEFAULT 0,
        fee_usd                  REAL    NOT NULL DEFAULT 0,
        method                   TEXT    NOT NULL DEFAULT 'FIFO',
        is_estimated_fee         INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS whale_candidates (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        address               TEXT    NOT NULL UNIQUE,
        first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
        last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
        volume_usd_24h        REAL    NOT NULL DEFAULT 0,
        trades_24h            INTEGER NOT NULL DEFAULT 0,
        max_single_trade_usd  REAL    NOT NULL DEFAULT 0,
        markets_7d            INTEGER NOT NULL DEFAULT 0,
        rank_score            REAL    NOT NULL DEFAULT 0,
        suggested_tags        TEXT    NOT NULL DEFAULT '[]',
        muted_until           TEXT,
        approved              INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id    INTEGER REFERENCES whales(id),
        type        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        delivered   INTEGER NOT NULL DEFAULT 0,
        read_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL,
        payload     TEXT    NOT NULL DEFAULT '{}',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        cursor_key  TEXT    NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS watchlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS watchlist_items (
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        whale_id     INTEGER NOT NULL REFERENCES whales(id) ON DELETE CASCADE,
        PRIMARY KEY (watchlist_id, whale_id)
      );

      CREATE TABLE IF NOT EXISTS shadow_portfolios (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        whale_id     INTEGER NOT NULL REFERENCES whales(id),
        mode         TEXT    NOT NULL DEFAULT 'paper',
        positions    TEXT    NOT NULL DEFAULT '[]',
        pnl_series   TEXT    NOT NULL DEFAULT '[]',
        total_pnl    REAL    NOT NULL DEFAULT 0,
        drawdown     REAL    NOT NULL DEFAULT 0,
        last_updated TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE(whale_id)
      );

      /* ── Indexes ── */
      CREATE INDEX IF NOT EXISTS idx_whale_trades_whale_ts     ON whale_trades(whale_id, ts);
      CREATE INDEX IF NOT EXISTS idx_whale_trades_market_ts    ON whale_trades(market_id, ts);
      CREATE INDEX IF NOT EXISTS idx_whale_metrics_whale_date  ON whale_metrics_daily(whale_id, date);
      CREATE INDEX IF NOT EXISTS idx_alerts_created            ON alerts(created_at);
      CREATE INDEX IF NOT EXISTS idx_signals_created           ON signals(created_at);
      CREATE INDEX IF NOT EXISTS idx_whale_candidates_rank     ON whale_candidates(rank_score DESC);
      CREATE INDEX IF NOT EXISTS idx_whale_trades_trade_id     ON whale_trades(trade_id);
    `);
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     WHALE CRUD
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  addWhale(address: string, opts?: { displayName?: string; tags?: string[]; notes?: string }): Whale {
    const stmt = this.db.prepare(`
      INSERT INTO whales (address, display_name, tags, notes)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, whales.display_name),
        updated_at = datetime('now')
      RETURNING *
    `);
    const row = stmt.get(
      address.toLowerCase(),
      opts?.displayName ?? null,
      JSON.stringify(opts?.tags ?? []),
      opts?.notes ?? '',
    ) as Record<string, unknown>;
    return this.rowToWhale(row);
  }

  bulkAddWhales(addresses: string[]): Whale[] {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO whales (address) VALUES (?)
    `);
    const trx = this.db.transaction((addrs: string[]) => {
      for (const addr of addrs) insert.run(addr.toLowerCase());
    });
    trx(addresses);
    return addresses.map((a) => this.getWhaleByAddress(a.toLowerCase())).filter(Boolean) as Whale[];
  }

  getWhale(id: number): Whale | undefined {
    const row = this.db.prepare('SELECT * FROM whales WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToWhale(row) : undefined;
  }

  getWhaleByAddress(address: string): Whale | undefined {
    const row = this.db.prepare('SELECT * FROM whales WHERE address = ?').get(address.toLowerCase()) as Record<string, unknown> | undefined;
    return row ? this.rowToWhale(row) : undefined;
  }

  listWhales(opts?: {
    starred?: boolean;
    trackingEnabled?: boolean;
    style?: string;
    tag?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
  }): { whales: Whale[]; total: number } {
    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (opts?.starred !== undefined) { where += ' AND starred = ?'; params.push(opts.starred ? 1 : 0); }
    if (opts?.trackingEnabled !== undefined) { where += ' AND tracking_enabled = ?'; params.push(opts.trackingEnabled ? 1 : 0); }
    if (opts?.style) { where += ' AND style = ?'; params.push(opts.style); }
    if (opts?.tag) { where += ' AND tags LIKE ?'; params.push(`%${opts.tag}%`); }

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM whales ${where}`).get(...params) as { cnt: number };
    const orderBy = opts?.orderBy ?? 'last_active_at DESC NULLS LAST';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const rows = this.db.prepare(`SELECT * FROM whales ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];

    return { whales: rows.map((r) => this.rowToWhale(r)), total: countRow.cnt };
  }

  updateWhale(id: number, updates: Partial<Pick<Whale, 'displayName' | 'starred' | 'trackingEnabled' | 'tags' | 'notes' | 'style' | 'dataIntegrity' | 'copyMode' | 'lastActiveAt' | 'lastBackfillAt' | 'lastTradeCursor'>>): void {
    const sets: string[] = ['updated_at = datetime(\'now\')'];
    const params: unknown[] = [];
    if (updates.displayName !== undefined) { sets.push('display_name = ?'); params.push(updates.displayName); }
    if (updates.starred !== undefined) { sets.push('starred = ?'); params.push(updates.starred ? 1 : 0); }
    if (updates.trackingEnabled !== undefined) { sets.push('tracking_enabled = ?'); params.push(updates.trackingEnabled ? 1 : 0); }
    if (updates.tags !== undefined) { sets.push('tags = ?'); params.push(JSON.stringify(updates.tags)); }
    if (updates.notes !== undefined) { sets.push('notes = ?'); params.push(updates.notes); }
    if (updates.style !== undefined) { sets.push('style = ?'); params.push(updates.style); }
    if (updates.dataIntegrity !== undefined) { sets.push('data_integrity = ?'); params.push(updates.dataIntegrity); }
    if (updates.copyMode !== undefined) { sets.push('copy_mode = ?'); params.push(updates.copyMode); }
    if (updates.lastActiveAt !== undefined) { sets.push('last_active_at = ?'); params.push(updates.lastActiveAt); }
    if (updates.lastBackfillAt !== undefined) { sets.push('last_backfill_at = ?'); params.push(updates.lastBackfillAt); }
    if (updates.lastTradeCursor !== undefined) { sets.push('last_trade_cursor = ?'); params.push(updates.lastTradeCursor); }
    params.push(id);
    this.db.prepare(`UPDATE whales SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteWhale(id: number): void {
    // Soft delete: disable tracking and clear from watchlists
    this.db.prepare('UPDATE whales SET tracking_enabled = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     TRADES
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  insertTrade(trade: Omit<WhaleTrade, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_trades
        (whale_id, trade_id, logical_trade_group_id, market_id, outcome, side,
         price, size, notional_usd, fee_usd, is_fee_estimated, ts,
         midpoint_at_fill, best_bid_at_fill, best_ask_at_fill, slippage_bps, aggressor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const info = stmt.run(
      trade.whaleId, trade.tradeId, trade.logicalTradeGroupId,
      trade.marketId, trade.outcome, trade.side,
      trade.price, trade.size, trade.notionalUsd,
      trade.feeUsd, trade.isFeeEstimated ? 1 : 0, trade.ts,
      trade.midpointAtFill, trade.bestBidAtFill, trade.bestAskAtFill,
      trade.slippageBps, trade.aggressor,
    );
    return Number(info.lastInsertRowid);
  }

  insertTrades(trades: Omit<WhaleTrade, 'id'>[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO whale_trades
        (whale_id, trade_id, logical_trade_group_id, market_id, outcome, side,
         price, size, notional_usd, fee_usd, is_fee_estimated, ts,
         midpoint_at_fill, best_bid_at_fill, best_ask_at_fill, slippage_bps, aggressor)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let inserted = 0;
    const trx = this.db.transaction((list: Omit<WhaleTrade, 'id'>[]) => {
      for (const t of list) {
        const info = stmt.run(
          t.whaleId, t.tradeId, t.logicalTradeGroupId,
          t.marketId, t.outcome, t.side,
          t.price, t.size, t.notionalUsd,
          t.feeUsd, t.isFeeEstimated ? 1 : 0, t.ts,
          t.midpointAtFill, t.bestBidAtFill, t.bestAskAtFill,
          t.slippageBps, t.aggressor,
        );
        if (info.changes > 0) inserted++;
      }
    });
    trx(trades);
    return inserted;
  }

  getWhaleTrades(whaleId: number, opts?: { limit?: number; cursor?: string; marketId?: string }): WhaleTrade[] {
    let where = 'WHERE whale_id = ?';
    const params: unknown[] = [whaleId];
    if (opts?.cursor) { where += ' AND ts < ?'; params.push(opts.cursor); }
    if (opts?.marketId) { where += ' AND market_id = ?'; params.push(opts.marketId); }
    const limit = opts?.limit ?? 100;
    const rows = this.db.prepare(`SELECT * FROM whale_trades ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTrade(r));
  }

  getMarketTrades(marketId: string, opts?: { limit?: number }): WhaleTrade[] {
    const rows = this.db.prepare(
      'SELECT * FROM whale_trades WHERE market_id = ? ORDER BY ts DESC LIMIT ?',
    ).all(marketId, opts?.limit ?? 100) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTrade(r));
  }

  getTradeByTradeId(whaleId: number, tradeId: string): WhaleTrade | undefined {
    const row = this.db.prepare(
      'SELECT * FROM whale_trades WHERE whale_id = ? AND trade_id = ?',
    ).get(whaleId, tradeId) as Record<string, unknown> | undefined;
    return row ? this.rowToTrade(row) : undefined;
  }

  getWhaleTradeCount(whaleId: number, sinceDate?: string): number {
    const where = sinceDate
      ? 'WHERE whale_id = ? AND ts >= ?'
      : 'WHERE whale_id = ?';
    const params: unknown[] = sinceDate ? [whaleId, sinceDate] : [whaleId];
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM whale_trades ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  getWhaleVolume(whaleId: number, sinceDate?: string): number {
    const where = sinceDate
      ? 'WHERE whale_id = ? AND ts >= ?'
      : 'WHERE whale_id = ?';
    const params: unknown[] = sinceDate ? [whaleId, sinceDate] : [whaleId];
    const row = this.db.prepare(`SELECT COALESCE(SUM(notional_usd),0) as vol FROM whale_trades ${where}`).get(...params) as { vol: number };
    return row.vol;
  }

  getWhaleDistinctMarkets(whaleId: number, sinceDate?: string): number {
    const where = sinceDate
      ? 'WHERE whale_id = ? AND ts >= ?'
      : 'WHERE whale_id = ?';
    const params: unknown[] = sinceDate ? [whaleId, sinceDate] : [whaleId];
    const row = this.db.prepare(`SELECT COUNT(DISTINCT market_id) as cnt FROM whale_trades ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     POSITIONS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  upsertPosition(pos: WhalePosition): void {
    this.db.prepare(`
      INSERT INTO whale_positions (whale_id, market_id, outcome, net_shares, avg_entry_price, cost_basis, unrealized_pnl, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(whale_id, market_id, outcome) DO UPDATE SET
        net_shares = excluded.net_shares,
        avg_entry_price = excluded.avg_entry_price,
        cost_basis = excluded.cost_basis,
        unrealized_pnl = excluded.unrealized_pnl,
        updated_at = datetime('now')
    `).run(pos.whaleId, pos.marketId, pos.outcome, pos.netShares, pos.avgEntryPrice, pos.costBasis, pos.unrealizedPnl);
  }

  getPositions(whaleId: number): WhalePosition[] {
    const rows = this.db.prepare(
      'SELECT * FROM whale_positions WHERE whale_id = ? AND net_shares != 0',
    ).all(whaleId) as Record<string, unknown>[];
    return rows.map((r) => ({
      whaleId: r.whale_id as number,
      marketId: r.market_id as string,
      outcome: r.outcome as string,
      netShares: r.net_shares as number,
      avgEntryPrice: r.avg_entry_price as number,
      costBasis: r.cost_basis as number,
      unrealizedPnl: r.unrealized_pnl as number,
      updatedAt: r.updated_at as string,
    }));
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     METRICS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  upsertDailyMetrics(m: WhaleMetricsDaily): void {
    this.db.prepare(`
      INSERT INTO whale_metrics_daily
        (whale_id, date, realized_pnl, unrealized_pnl, volume_usd, trades_count,
         win_rate, avg_slippage_bps, avg_hold_minutes, timing_score,
         consistency_score, market_selection_score, score, score_confidence, score_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(whale_id, date) DO UPDATE SET
        realized_pnl = excluded.realized_pnl,
        unrealized_pnl = excluded.unrealized_pnl,
        volume_usd = excluded.volume_usd,
        trades_count = excluded.trades_count,
        win_rate = excluded.win_rate,
        avg_slippage_bps = excluded.avg_slippage_bps,
        avg_hold_minutes = excluded.avg_hold_minutes,
        timing_score = excluded.timing_score,
        consistency_score = excluded.consistency_score,
        market_selection_score = excluded.market_selection_score,
        score = excluded.score,
        score_confidence = excluded.score_confidence,
        score_version = excluded.score_version
    `).run(
      m.whaleId, m.date, m.realizedPnl, m.unrealizedPnl, m.volumeUsd, m.tradesCount,
      m.winRate, m.avgSlippageBps, m.avgHoldMinutes, m.timingScore,
      m.consistencyScore, m.marketSelectionScore, m.score, m.scoreConfidence, m.scoreVersion,
    );
  }

  getDailyMetrics(whaleId: number, opts?: { fromDate?: string; toDate?: string }): WhaleMetricsDaily[] {
    let where = 'WHERE whale_id = ?';
    const params: unknown[] = [whaleId];
    if (opts?.fromDate) { where += ' AND date >= ?'; params.push(opts.fromDate); }
    if (opts?.toDate) { where += ' AND date <= ?'; params.push(opts.toDate); }
    const rows = this.db.prepare(`SELECT * FROM whale_metrics_daily ${where} ORDER BY date`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      whaleId: r.whale_id as number,
      date: r.date as string,
      realizedPnl: r.realized_pnl as number,
      unrealizedPnl: r.unrealized_pnl as number,
      volumeUsd: r.volume_usd as number,
      tradesCount: r.trades_count as number,
      winRate: r.win_rate as number,
      avgSlippageBps: r.avg_slippage_bps as number,
      avgHoldMinutes: r.avg_hold_minutes as number,
      timingScore: r.timing_score as number,
      consistencyScore: r.consistency_score as number,
      marketSelectionScore: r.market_selection_score as number,
      score: r.score as number,
      scoreConfidence: r.score_confidence as number,
      scoreVersion: r.score_version as string,
    }));
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     SETTLEMENT LEDGER
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  insertSettlementEntry(e: Omit<SettlementLedgerEntry, 'id'>): number {
    const info = this.db.prepare(`
      INSERT INTO whale_settlement_ledger
        (whale_id, market_id, outcome, lot_id, open_ts, close_ts, qty,
         entry_price, exit_price_or_settlement, realized_pnl, fee_usd, method, is_estimated_fee)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      e.whaleId, e.marketId, e.outcome, e.lotId, e.openTs, e.closeTs,
      e.qty, e.entryPrice, e.exitPriceOrSettlement, e.realizedPnl,
      e.feeUsd, e.method, e.isEstimatedFee ? 1 : 0,
    );
    return Number(info.lastInsertRowid);
  }

  getSettlementEntries(whaleId: number): SettlementLedgerEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM whale_settlement_ledger WHERE whale_id = ? ORDER BY open_ts',
    ).all(whaleId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      whaleId: r.whale_id as number,
      marketId: r.market_id as string,
      outcome: r.outcome as string,
      lotId: r.lot_id as string,
      openTs: r.open_ts as string,
      closeTs: r.close_ts as string | null,
      qty: r.qty as number,
      entryPrice: r.entry_price as number,
      exitPriceOrSettlement: r.exit_price_or_settlement as number | null,
      realizedPnl: r.realized_pnl as number,
      feeUsd: r.fee_usd as number,
      method: r.method as 'FIFO' | 'AVG',
      isEstimatedFee: (r.is_estimated_fee as number) === 1,
    }));
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     CANDIDATES
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  upsertCandidate(c: Omit<WhaleCandidate, 'id'>): void {
    this.db.prepare(`
      INSERT INTO whale_candidates
        (address, first_seen_at, last_seen_at, volume_usd_24h, trades_24h,
         max_single_trade_usd, markets_7d, rank_score, suggested_tags, muted_until, approved)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(address) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        volume_usd_24h = excluded.volume_usd_24h,
        trades_24h = excluded.trades_24h,
        max_single_trade_usd = excluded.max_single_trade_usd,
        markets_7d = excluded.markets_7d,
        rank_score = excluded.rank_score,
        suggested_tags = excluded.suggested_tags
    `).run(
      c.address.toLowerCase(), c.firstSeenAt, c.lastSeenAt,
      c.volumeUsd24h, c.trades24h, c.maxSingleTradeUsd,
      c.markets7d, c.rankScore, JSON.stringify(c.suggestedTags),
      c.mutedUntil, c.approved ? 1 : 0,
    );
  }

  listCandidates(opts?: { limit?: number; offset?: number; excludeApproved?: boolean; excludeMuted?: boolean }): WhaleCandidate[] {
    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (opts?.excludeApproved) { where += ' AND approved = 0'; }
    if (opts?.excludeMuted) { where += ' AND (muted_until IS NULL OR muted_until < datetime(\'now\'))'; }
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = this.db.prepare(
      `SELECT * FROM whale_candidates ${where} ORDER BY rank_score DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.rowToCandidate(r));
  }

  approveCandidate(address: string): void {
    this.db.prepare('UPDATE whale_candidates SET approved = 1 WHERE address = ?').run(address.toLowerCase());
  }

  muteCandidate(address: string, days = 30): void {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    this.db.prepare('UPDATE whale_candidates SET muted_until = ? WHERE address = ?').run(until, address.toLowerCase());
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ALERTS + SIGNALS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  insertAlert(alert: Omit<Alert, 'id'>): number {
    const info = this.db.prepare(`
      INSERT INTO alerts (whale_id, type, payload, created_at, delivered, read_at)
      VALUES (?, ?, ?, datetime('now'), 0, NULL)
    `).run(alert.whaleId, alert.type, JSON.stringify(alert.payload));
    return Number(info.lastInsertRowid);
  }

  listAlerts(opts?: { whaleId?: number; unreadOnly?: boolean; limit?: number; cursor?: string }): Alert[] {
    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (opts?.whaleId) { where += ' AND whale_id = ?'; params.push(opts.whaleId); }
    if (opts?.unreadOnly) { where += ' AND read_at IS NULL'; }
    if (opts?.cursor) { where += ' AND created_at < ?'; params.push(opts.cursor); }
    const rows = this.db.prepare(
      `SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, opts?.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAlert(r));
  }

  markAlertRead(id: number): void {
    this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE id = ?").run(id);
  }

  markAllAlertsRead(whaleId?: number): void {
    if (whaleId) {
      this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE whale_id = ? AND read_at IS NULL").run(whaleId);
    } else {
      this.db.prepare("UPDATE alerts SET read_at = datetime('now') WHERE read_at IS NULL").run();
    }
  }

  getUnreadAlertCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE read_at IS NULL').get() as { cnt: number };
    return row.cnt;
  }

  insertSignal(signal: Omit<WhaleSignal, 'id'>): number {
    const info = this.db.prepare(`
      INSERT INTO signals (type, payload, created_at, cursor_key)
      VALUES (?, ?, datetime('now'), ?)
    `).run(signal.type, JSON.stringify(signal.payload), signal.cursorKey);
    return Number(info.lastInsertRowid);
  }

  listSignals(opts?: { limit?: number; cursor?: string }): WhaleSignal[] {
    let where = 'WHERE 1=1';
    const params: unknown[] = [];
    if (opts?.cursor) { where += ' AND cursor_key > ?'; params.push(opts.cursor); }
    const rows = this.db.prepare(
      `SELECT * FROM signals ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, opts?.limit ?? 50) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      type: r.type as WhaleSignal['type'],
      payload: JSON.parse(r.payload as string) as Record<string, unknown>,
      createdAt: r.created_at as string,
      cursorKey: r.cursor_key as string,
    }));
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     WATCHLISTS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  createWatchlist(name: string): Watchlist {
    const info = this.db.prepare("INSERT INTO watchlists (name) VALUES (?)").run(name);
    return { id: Number(info.lastInsertRowid), name, createdAt: new Date().toISOString() };
  }

  listWatchlists(): Watchlist[] {
    const rows = this.db.prepare('SELECT * FROM watchlists ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as number, name: r.name as string, createdAt: r.created_at as string }));
  }

  deleteWatchlist(id: number): void {
    this.db.prepare('DELETE FROM watchlists WHERE id = ?').run(id);
  }

  addToWatchlist(watchlistId: number, whaleId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO watchlist_items (watchlist_id, whale_id) VALUES (?, ?)').run(watchlistId, whaleId);
  }

  removeFromWatchlist(watchlistId: number, whaleId: number): void {
    this.db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ? AND whale_id = ?').run(watchlistId, whaleId);
  }

  getWatchlistItems(watchlistId: number): Whale[] {
    const rows = this.db.prepare(`
      SELECT w.* FROM whales w
      JOIN watchlist_items wi ON wi.whale_id = w.id
      WHERE wi.watchlist_id = ?
      ORDER BY w.last_active_at DESC
    `).all(watchlistId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToWhale(r));
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     SHADOW PORTFOLIOS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  upsertShadowPortfolio(sp: Omit<ShadowPortfolio, 'id'>): void {
    this.db.prepare(`
      INSERT INTO shadow_portfolios (whale_id, mode, positions, pnl_series, total_pnl, drawdown, last_updated)
      VALUES (?, 'paper', ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(whale_id) DO UPDATE SET
        positions = excluded.positions,
        pnl_series = excluded.pnl_series,
        total_pnl = excluded.total_pnl,
        drawdown = excluded.drawdown,
        last_updated = datetime('now')
    `).run(
      sp.whaleId,
      JSON.stringify(sp.positions),
      JSON.stringify(sp.pnlSeries),
      sp.totalPnl,
      sp.drawdown,
    );
  }

  getShadowPortfolio(whaleId: number): ShadowPortfolio | undefined {
    const row = this.db.prepare('SELECT * FROM shadow_portfolios WHERE whale_id = ?').get(whaleId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: row.id as number,
      whaleId: row.whale_id as number,
      mode: 'paper',
      positions: JSON.parse(row.positions as string) as ShadowPosition[],
      pnlSeries: JSON.parse(row.pnl_series as string) as number[],
      totalPnl: row.total_pnl as number,
      drawdown: row.drawdown as number,
      lastUpdated: row.last_updated as string,
    };
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     AGGREGATION HELPERS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  /** Sum realized PnL from settlement ledger */
  getSettledPnl(whaleId: number, sinceDate?: string): number {
    const where = sinceDate
      ? 'WHERE whale_id = ? AND close_ts >= ?'
      : 'WHERE whale_id = ?';
    const params: unknown[] = sinceDate ? [whaleId, sinceDate] : [whaleId];
    const row = this.db.prepare(`SELECT COALESCE(SUM(realized_pnl),0) as pnl FROM whale_settlement_ledger ${where}`).get(...params) as { pnl: number };
    return row.pnl;
  }

  /** Win rate from settlement ledger */
  getWinRate(whaleId: number): number {
    const total = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM whale_settlement_ledger WHERE whale_id = ? AND close_ts IS NOT NULL',
    ).get(whaleId) as { cnt: number };
    if (total.cnt === 0) return 0;
    const wins = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM whale_settlement_ledger WHERE whale_id = ? AND close_ts IS NOT NULL AND realized_pnl > 0',
    ).get(whaleId) as { cnt: number };
    return wins.cnt / total.cnt;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     ROW CONVERTERS
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private rowToWhale(r: Record<string, unknown>): Whale {
    return {
      id: r.id as number,
      address: r.address as string,
      displayName: r.display_name as string | null,
      starred: (r.starred as number) === 1,
      trackingEnabled: (r.tracking_enabled as number) === 1,
      tags: JSON.parse(r.tags as string || '[]') as string[],
      notes: r.notes as string,
      style: r.style as Whale['style'],
      dataIntegrity: r.data_integrity as Whale['dataIntegrity'],
      copyMode: r.copy_mode as Whale['copyMode'],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      lastActiveAt: r.last_active_at as string | null,
      lastBackfillAt: r.last_backfill_at as string | null,
      lastTradeCursor: r.last_trade_cursor as string | null,
    };
  }

  private rowToTrade(r: Record<string, unknown>): WhaleTrade {
    return {
      id: r.id as number,
      whaleId: r.whale_id as number,
      tradeId: r.trade_id as string | null,
      logicalTradeGroupId: r.logical_trade_group_id as string | null,
      marketId: r.market_id as string,
      outcome: r.outcome as string,
      side: r.side as 'BUY' | 'SELL',
      price: r.price as number,
      size: r.size as number,
      notionalUsd: r.notional_usd as number,
      feeUsd: r.fee_usd as number,
      isFeeEstimated: (r.is_fee_estimated as number) === 1,
      ts: r.ts as string,
      midpointAtFill: r.midpoint_at_fill as number | null,
      bestBidAtFill: r.best_bid_at_fill as number | null,
      bestAskAtFill: r.best_ask_at_fill as number | null,
      slippageBps: r.slippage_bps as number | null,
      aggressor: r.aggressor as AggressorSide,
    };
  }

  private rowToCandidate(r: Record<string, unknown>): WhaleCandidate {
    return {
      id: r.id as number,
      address: r.address as string,
      firstSeenAt: r.first_seen_at as string,
      lastSeenAt: r.last_seen_at as string,
      volumeUsd24h: r.volume_usd_24h as number,
      trades24h: r.trades_24h as number,
      maxSingleTradeUsd: r.max_single_trade_usd as number,
      markets7d: r.markets_7d as number,
      rankScore: r.rank_score as number,
      suggestedTags: JSON.parse(r.suggested_tags as string || '[]') as string[],
      mutedUntil: r.muted_until as string | null,
      approved: (r.approved as number) === 1,
    };
  }

  private rowToAlert(r: Record<string, unknown>): Alert {
    return {
      id: r.id as number,
      whaleId: r.whale_id as number | null,
      type: r.type as AlertType,
      payload: JSON.parse(r.payload as string || '{}') as Record<string, unknown>,
      createdAt: r.created_at as string,
      delivered: (r.delivered as number) === 1,
      readAt: r.read_at as string | null,
    };
  }
}
