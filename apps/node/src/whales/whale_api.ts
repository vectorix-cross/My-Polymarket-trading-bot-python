/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Whale Tracking — REST API
   20+ endpoints for the whale tracking engine.
   Registers routes on the existing dashboard HTTP server.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import type { IncomingMessage, ServerResponse } from 'http';
import type { WhaleService } from './whale_service';
import { logger } from '../reporting/logs';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const qs: Record<string, string> = {};
  const parts = url.slice(idx + 1).split('&');
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k) qs[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  }
  return qs;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class WhaleAPI {
  private service: WhaleService;
  private routes: Route[] = [];

  constructor(service: WhaleService) {
    this.service = service;
    this.registerRoutes();
  }

  /* ━━━━━━━━━━━━━━ Route registration ━━━━━━━━━━━━━━ */

  private registerRoutes(): void {
    // Summary
    this.route('GET', '/api/whales/summary', this.getSummary);

    // Scanner (must be registered before :id routes)
    this.route('GET', '/api/whales/scanner/state', this.getScannerState);
    this.route('POST', '/api/whales/scanner/start', this.startScanner);
    this.route('POST', '/api/whales/scanner/stop', this.stopScanner);
    this.route('POST', '/api/whales/scanner/scan', this.triggerScan);
    this.route('GET', '/api/whales/scanner/report', this.getScannerReport);
    this.route('GET', '/api/whales/scanner/profiles', this.getScannerProfiles);
    this.route('GET', '/api/whales/scanner/profiles/:address', this.getScannerProfile);
    this.route('POST', '/api/whales/scanner/promote/:address', this.promoteScannedWhale);
    this.route('GET', '/api/whales/scanner/clusters', this.getScannerClusters);
    this.route('GET', '/api/whales/scanner/signals', this.getScannerSignals);
    this.route('GET', '/api/whales/scanner/network', this.getScannerNetwork);
    this.route('GET', '/api/whales/scanner/copysim', this.getCopySimResults);
    this.route('GET', '/api/whales/scanner/copysim/:address', this.getCopySimResult);
    this.route('GET', '/api/whales/scanner/regime', this.getRegimeState);
    this.route('GET', '/api/whales/scanner/apipool', this.getApiPoolStatus);
    this.route('GET', '/api/whales/scanner/balance/:address', this.getWalletBalance);

    // Whale CRUD
    this.route('GET', '/api/whales', this.listWhales);
    this.route('POST', '/api/whales', this.addWhale);
    this.route('GET', '/api/whales/:id', this.getWhale);
    this.route('PATCH', '/api/whales/:id', this.updateWhale);
    this.route('DELETE', '/api/whales/:id', this.deleteWhale);

    // Whale detail & sub-resources
    this.route('GET', '/api/whales/:id/detail', this.getWhaleDetail);
    this.route('GET', '/api/whales/:id/trades', this.getWhaleTrades);
    this.route('GET', '/api/whales/:id/positions', this.getWhalePositions);
    this.route('GET', '/api/whales/:id/score', this.getWhaleScore);
    this.route('GET', '/api/whales/:id/timing', this.getTimingAnalysis);
    this.route('GET', '/api/whales/:id/metrics', this.getDailyMetrics);
    this.route('GET', '/api/whales/:id/shadow', this.getShadowPortfolio);

    // Comparison
    this.route('GET', '/api/whales/compare', this.compareWhales);

    // Market whale activity
    this.route('GET', '/api/whales/market/:marketId', this.getMarketWhaleActivity);

    // Candidates
    this.route('GET', '/api/whales/candidates', this.listCandidates);
    this.route('POST', '/api/whales/candidates/:address/approve', this.approveCandidate);
    this.route('POST', '/api/whales/candidates/:address/mute', this.muteCandidate);

    // Alerts
    this.route('GET', '/api/whales/alerts', this.listAlerts);
    this.route('POST', '/api/whales/alerts/:id/read', this.markAlertRead);
    this.route('POST', '/api/whales/alerts/read-all', this.markAllAlertsRead);

    // Signals
    this.route('GET', '/api/whales/signals', this.listSignals);

    // Watchlists
    this.route('GET', '/api/whales/watchlists', this.listWatchlists);
    this.route('POST', '/api/whales/watchlists', this.createWatchlist);
    this.route('DELETE', '/api/whales/watchlists/:id', this.deleteWatchlist);
    this.route('GET', '/api/whales/watchlists/:id/items', this.getWatchlistItems);
    this.route('POST', '/api/whales/watchlists/:id/items', this.addToWatchlist);
    this.route('DELETE', '/api/whales/watchlists/:id/items/:whaleId', this.removeFromWatchlist);

    // Reconciliation
    this.route('POST', '/api/whales/reconcile', this.runReconciliation);
  }

  /* ━━━━━━━━━━━━━━ Route matching ━━━━━━━━━━━━━━ */

  private route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${pattern}(\\?.*)?$`),
      paramNames,
      handler: handler.bind(this),
    });
  }

  /**
   * Handle an incoming request. Returns true if handled, false if no match.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = url.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = match[i + 1];
        });
        try {
          await route.handler(req, res, params);
        } catch (err) {
          logger.error({ err, url }, 'Whale API error');
          json(res, { error: 'Internal server error' }, 500);
        }
        return true;
      }
    }
    return false;
  }

  /* ━━━━━━━━━━━━━━ Handlers ━━━━━━━━━━━━━━ */

  private async getSummary(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, this.service.getSummary());
  }

  private async listWhales(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    const result = this.service.listWhales({
      starred: q.starred === 'true' ? true : q.starred === 'false' ? false : undefined,
      trackingEnabled: q.tracking === 'true' ? true : q.tracking === 'false' ? false : undefined,
      style: q.style || undefined,
      tag: q.tag || undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
      orderBy: q.orderBy || undefined,
    });
    json(res, result);
  }

  private async addWhale(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as { address: string; displayName?: string; tags?: string[]; notes?: string };
    if (!body.address) {
      json(res, { error: 'address is required' }, 400);
      return;
    }
    const whale = this.service.addWhale(body.address, {
      displayName: body.displayName,
      tags: body.tags,
      notes: body.notes,
    });
    json(res, whale, 201);
  }

  private async getWhale(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const whale = this.service.getWhale(parseInt(params.id, 10));
    if (!whale) { json(res, { error: 'Not found' }, 404); return; }
    json(res, whale);
  }

  private async updateWhale(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    this.service.updateWhale(parseInt(params.id, 10), body);
    json(res, { ok: true });
  }

  private async deleteWhale(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    this.service.deleteWhale(parseInt(params.id, 10));
    json(res, { ok: true });
  }

  private async getWhaleDetail(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const detail = this.service.getWhaleDetail(parseInt(params.id, 10));
    if (!detail) { json(res, { error: 'Not found' }, 404); return; }
    json(res, detail);
  }

  private async getWhaleTrades(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const q = parseQuery(req.url ?? '');
    const trades = this.service.getWhaleTrades(parseInt(params.id, 10), {
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      cursor: q.cursor || undefined,
      marketId: q.marketId || undefined,
    });
    json(res, trades);
  }

  private async getWhalePositions(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    json(res, this.service.getWhalePositions(parseInt(params.id, 10)));
  }

  private async getWhaleScore(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    json(res, this.service.getWhaleScore(parseInt(params.id, 10)));
  }

  private async getTimingAnalysis(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    json(res, this.service.getTimingAnalysis(parseInt(params.id, 10)));
  }

  private async getDailyMetrics(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const q = parseQuery(req.url ?? '');
    json(res, this.service.getDailyMetrics(parseInt(params.id, 10), q.from, q.to));
  }

  private async getShadowPortfolio(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const sp = this.service.getShadowPortfolio(parseInt(params.id, 10));
    if (!sp) { json(res, { error: 'No shadow portfolio' }, 404); return; }
    json(res, sp);
  }

  private async compareWhales(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    const ids = (q.ids ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    if (ids.length < 2) { json(res, { error: 'Provide at least 2 whale ids via ?ids=1,2' }, 400); return; }
    json(res, this.service.compareWhales(ids));
  }

  private async getMarketWhaleActivity(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    json(res, this.service.getMarketWhaleActivity(params.marketId));
  }

  private async listCandidates(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    json(res, this.service.listCandidates({
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    }));
  }

  private async approveCandidate(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const whale = this.service.approveCandidate(params.address);
    json(res, whale, 201);
  }

  private async muteCandidate(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = JSON.parse(await readBody(req) || '{}') as { days?: number };
    this.service.muteCandidate(params.address, body.days);
    json(res, { ok: true });
  }

  private async listAlerts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    json(res, this.service.getAlerts({
      whaleId: q.whaleId ? parseInt(q.whaleId, 10) : undefined,
      unreadOnly: q.unread === 'true',
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      cursor: q.cursor || undefined,
    }));
  }

  private async markAlertRead(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    this.service.markAlertRead(parseInt(params.id, 10));
    json(res, { ok: true });
  }

  private async markAllAlertsRead(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    this.service.markAllAlertsRead(q.whaleId ? parseInt(q.whaleId, 10) : undefined);
    json(res, { ok: true });
  }

  private async listSignals(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    json(res, this.service.getSignals({
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      cursor: q.cursor || undefined,
    }));
  }

  private async listWatchlists(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, this.service.listWatchlists());
  }

  private async createWatchlist(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as { name: string };
    if (!body.name) { json(res, { error: 'name is required' }, 400); return; }
    json(res, this.service.createWatchlist(body.name), 201);
  }

  private async deleteWatchlist(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    this.service.deleteWatchlist(parseInt(params.id, 10));
    json(res, { ok: true });
  }

  private async getWatchlistItems(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    json(res, this.service.getWatchlistItems(parseInt(params.id, 10)));
  }

  private async addToWatchlist(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = JSON.parse(await readBody(req)) as { whaleId: number };
    if (!body.whaleId) { json(res, { error: 'whaleId is required' }, 400); return; }
    this.service.addToWatchlist(parseInt(params.id, 10), body.whaleId);
    json(res, { ok: true });
  }

  private async removeFromWatchlist(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    this.service.removeFromWatchlist(parseInt(params.id, 10), parseInt(params.whaleId, 10));
    json(res, { ok: true });
  }

  private async runReconciliation(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reports = await this.service.runReconciliation();
    json(res, reports);
  }

  /* ━━━━━━━━━━━━━━ Scanner handlers ━━━━━━━━━━━━━━ */

  private async getScannerState(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, this.service.getScannerState());
  }

  private async startScanner(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.service.startScanner();
    json(res, { ok: true, status: 'started' });
  }

  private async stopScanner(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.service.stopScanner();
    json(res, { ok: true, status: 'stopped' });
  }

  private async triggerScan(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const profiles = await this.service.triggerScan();
    json(res, profiles);
  }

  private async getScannerReport(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, this.service.getScannerResults());
  }

  private async getScannerProfiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const q = parseQuery(req.url ?? '');
    const all = this.service.getScannerResults();
    const minScore = q.minScore ? parseFloat(q.minScore) : 0;
    const limit = q.limit ? parseInt(q.limit, 10) : 100;
    const qualified = q.qualified !== 'false';
    const filtered = all
      .filter((p) => p.compositeScore >= minScore)
      .filter((p) => (qualified ? !p.alreadyTracked : true))
      .slice(0, limit);
    json(res, filtered);
  }

  private async promoteScannedWhale(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (!params.address) { json(res, { error: 'address is required' }, 400); return; }
    const whale = this.service.promoteScannedWhale(params.address);
    json(res, whale, 201);
  }

  private async getScannerProfile(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (!params.address) { json(res, { error: 'address is required' }, 400); return; }
    const profile = this.service.getScannerProfile(params.address);
    if (!profile) { json(res, { error: 'Profile not found' }, 404); return; }
    json(res, profile);
  }

  private async getScannerClusters(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clusters = this.service.getScannerClusters();
    json(res, clusters);
  }

  private async getScannerSignals(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signals = this.service.getClusterSignals();
    json(res, signals);
  }

  private async getScannerNetwork(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const graph = this.service.getNetworkGraph();
    json(res, graph ?? { nodes: [], edges: [], avgConnectivity: 0, densestCluster: [], computedAt: null });
  }

  private async getCopySimResults(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const results = this.service.getCopySimResults();
    json(res, results);
  }

  private async getCopySimResult(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (!params.address) { json(res, { error: 'address is required' }, 400); return; }
    const result = this.service.getCopySimResult(params.address);
    if (!result) { json(res, { error: 'No simulation for this address' }, 404); return; }
    json(res, result);
  }

  private async getRegimeState(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const regime = this.service.getRegimeState();
    json(res, regime ?? { regime: 'UNKNOWN', confidence: 0, evaluatedAt: null, adjustedWeights: {}, metrics: {} });
  }

  private async getApiPoolStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const status = this.service.getApiPoolStatus();
    json(res, status);
  }

  private async getWalletBalance(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    if (!params.address) { json(res, { error: 'address is required' }, 400); return; }
    const balance = this.service.getWalletBalance(params.address);
    json(res, { address: params.address, balanceUsdc: balance ?? null });
  }
}
