import { EventEmitter } from 'events';
import http from 'http';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ConsoleLog — Global in-memory log ring-buffer + SSE broadcaster
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Provides a central place to log structured trading events that
   are then:
     1. Stored in a fixed-size ring buffer (last N entries)
     2. Broadcast via Server-Sent Events to connected dashboard clients

   Categories:
     SCAN      – market data polling / scanning
     SIGNAL    – strategy signal generation
     ORDER     – order sizing, routing, submission
     FILL      – trade fills (paper or live)
     POSITION  – position management (exits, trailing stops)
     RISK      – risk checks, limit breaches
     ENGINE    – engine lifecycle (start, stop, tick)
     STRATEGY  – strategy init, config, shutdown
     WALLET    – wallet registration, creation, removal
     SYSTEM    – general system events
     ERROR     – errors and warnings

   Levels:  DEBUG | INFO | WARN | ERROR | SUCCESS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

export type LogCategory =
  | 'SCAN'
  | 'SIGNAL'
  | 'ORDER'
  | 'FILL'
  | 'POSITION'
  | 'RISK'
  | 'ENGINE'
  | 'STRATEGY'
  | 'WALLET'
  | 'SYSTEM'
  | 'ERROR';

export interface ConsoleEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: LogCategory;
  message: string;
  /** Optional structured data for the detail pane */
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 500;

class ConsoleLogSingleton extends EventEmitter {
  private readonly buffer: ConsoleEntry[] = [];
  private seq = 0;
  private readonly sseClients = new Set<http.ServerResponse>();

  /* ── Public API ─────────────────────────────────────────────── */

  log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: ConsoleEntry = {
      id: ++this.seq,
      timestamp: Date.now(),
      level,
      category,
      message,
      data,
    };

    // Ring buffer
    this.buffer.push(entry);
    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer.shift();
    }

    // Broadcast to SSE clients
    this.broadcast(entry);

    // EventEmitter for in-process listeners
    this.emit('entry', entry);
  }

  /* Convenience methods */
  debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', category, message, data);
  }
  info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log('INFO', category, message, data);
  }
  warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log('WARN', category, message, data);
  }
  error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log('ERROR', category, message, data);
  }
  success(category: LogCategory, message: string, data?: Record<string, unknown>): void {
    this.log('SUCCESS', category, message, data);
  }

  /* ── Buffer access ──────────────────────────────────────────── */

  getEntries(limit = 500, offset = 0): ConsoleEntry[] {
    const start = Math.max(0, this.buffer.length - limit - offset);
    const end = this.buffer.length - offset;
    return this.buffer.slice(start, end);
  }

  getEntriesSince(sinceId: number): ConsoleEntry[] {
    const idx = this.buffer.findIndex((e) => e.id > sinceId);
    if (idx === -1) return [];
    return this.buffer.slice(idx);
  }

  getStats(): {
    total: number;
    byLevel: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const e of this.buffer) {
      byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    }
    return { total: this.buffer.length, byLevel, byCategory };
  }

  /* ── SSE (Server-Sent Events) ───────────────────────────────── */

  /** Handle an incoming SSE connection from the dashboard */
  addSSEClient(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send recent history as a burst so the client is immediately populated
    const recent = this.getEntries(200);
    for (const entry of recent) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    this.sseClients.add(res);

    res.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  private broadcast(entry: ConsoleEntry): void {
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}

/** Global singleton */
export const consoleLog = new ConsoleLogSingleton();
