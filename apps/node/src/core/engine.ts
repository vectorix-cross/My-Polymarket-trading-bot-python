import { Scheduler } from './scheduler';
import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher } from '../data/clob_fetcher';
import { WalletManager } from '../wallets/wallet_manager';
import { OrderRouter } from '../execution/order_router';
import { StrategyInterface } from '../strategies/strategy_interface';
import { STRATEGY_REGISTRY } from '../strategies/registry';
import { AppConfig, MarketData } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

interface StrategyRunner {
  strategy: StrategyInterface;
  walletId: string;
  config: Record<string, unknown>;
}

export class Engine {
  private readonly scheduler = new Scheduler();
  private readonly stream: OrderbookStream;
  private readonly clobFetcher: ClobFetcher;
  private readonly runners: StrategyRunner[] = [];
  private readonly pausedWallets = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly walletManager: WalletManager,
    private readonly orderRouter: OrderRouter,
  ) {
    // Pass Gamma API URL from config to the OrderbookStream
    this.stream = new OrderbookStream(config.polymarket.gammaApi);
    this.clobFetcher = new ClobFetcher(config.polymarket.clobApi);
    this.walletManager.setPaperDependencies(this.stream, this.clobFetcher);
  }

  async initialize(): Promise<void> {
    for (const wallet of this.config.wallets) {
      const StrategyCtor = STRATEGY_REGISTRY[wallet.strategy];
      if (!StrategyCtor) {
        logger.warn({ strategy: wallet.strategy }, 'Unknown strategy; skipping');
        consoleLog.warn('ENGINE', `Unknown strategy "${wallet.strategy}" — skipping wallet ${wallet.id}`);
        continue;
      }
      const walletState = this.walletManager.getWallet(wallet.id)?.getState();
      if (!walletState) {
        continue;
      }
      const strategy = new StrategyCtor();
      strategy.initialize({
        wallet: walletState,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      this.runners.push({
        strategy,
        walletId: wallet.id,
        config: this.config.strategyConfig[wallet.strategy] ?? {},
      });
      consoleLog.info('STRATEGY', `Initialized "${wallet.strategy}" for wallet ${wallet.id}`, {
        walletId: wallet.id,
        strategy: wallet.strategy,
        capital: walletState.capitalAllocated,
        mode: walletState.mode,
      });
    }

    this.stream.on('update', (data) => this.handleMarketUpdate(data));
  }

  start(): void {
    this.stream.start();
    this.scheduler.start(() => this.tick());
    logger.info({ wallets: this.runners.length }, 'Engine started with LIVE Polymarket data');
    consoleLog.success('ENGINE', `Engine started — ${this.runners.length} strategy runners active`, {
      runners: this.runners.length,
      strategies: [...new Set(this.runners.map((r) => r.strategy.name))],
    });
  }

  stop(): void {
    this.scheduler.stop();
    this.stream.stop();
    logger.info('Engine stopped');
    consoleLog.warn('ENGINE', 'Engine stopped');
  }

  /** Expose the stream so the dashboard can query live market data */
  getStream(): OrderbookStream {
    return this.stream;
  }

  /* ━━━━━━━━━━━━━━ Runtime runner management ━━━━━━━━━━━━━━ */

  /**
   * Add a strategy runner for a wallet that was created at runtime
   * (e.g. via the dashboard).  The runner immediately receives all
   * cached market data so the strategy has context for its first tick.
   */
  addRunner(walletId: string, strategyKey: string): boolean {
    // Prevent duplicate runners for the same wallet
    if (this.runners.some((r) => r.walletId === walletId)) {
      logger.warn({ walletId }, 'Runner already exists for wallet');
      return false;
    }

    const StrategyCtor = STRATEGY_REGISTRY[strategyKey];
    if (!StrategyCtor) {
      logger.warn({ walletId, strategy: strategyKey }, 'Unknown strategy; cannot add runner');
      return false;
    }

    const walletState = this.walletManager.getWallet(walletId)?.getState();
    if (!walletState) {
      logger.warn({ walletId }, 'Wallet not found in WalletManager');
      return false;
    }

    const strategy = new StrategyCtor();
    const cfg = this.config.strategyConfig[strategyKey] ?? {};
    strategy.initialize({ wallet: walletState, config: cfg });

    this.runners.push({ strategy, walletId, config: cfg });

    // Back-fill cached market data so the strategy can evaluate immediately
    for (const market of this.stream.getAllMarkets()) {
      strategy.onMarketUpdate(market);
    }

    logger.info(
      { walletId, strategy: strategyKey, cachedMarkets: this.stream.getAllMarkets().length },
      `Runtime runner added for wallet ${walletId} (${strategyKey})`,
    );
    consoleLog.success('WALLET', `Runtime runner added: ${walletId} → ${strategyKey}`, {
      walletId,
      strategy: strategyKey,
      cachedMarkets: this.stream.getAllMarkets().length,
    });
    return true;
  }

  /**
   * Remove the strategy runner for a wallet (e.g. on wallet deletion).
   */
  removeRunner(walletId: string): boolean {
    const idx = this.runners.findIndex((r) => r.walletId === walletId);
    if (idx === -1) return false;

    const runner = this.runners[idx];
    runner.strategy.shutdown();
    this.runners.splice(idx, 1);
    logger.info({ walletId }, `Runtime runner removed for wallet ${walletId}`);
    consoleLog.warn('WALLET', `Runner removed: ${walletId} (${runner.strategy.name})`, {
      walletId,
      strategy: runner.strategy.name,
      remainingRunners: this.runners.length,
    });
    return true;
  }

  /** Number of active strategy runners (for dashboard display). */
  getRunnerCount(): number {
    return this.runners.length;
  }

  /** Get all strategy instances that match a given strategy name (for runtime config). */
  getStrategiesByName(strategyName: string): StrategyInterface[] {
    return this.runners
      .filter((r) => r.config === this.config.strategyConfig[strategyName] || r.strategy.name === strategyName)
      .map((r) => r.strategy);
  }

  /* ━━━━━━━━━━━━━━ Pause / Resume ━━━━━━━━━━━━━━ */

  /**
   * Pause a wallet's strategy runner.  The runner stays in the list
   * (and still receives market updates to stay in-sync) but will not
   * generate signals, size positions, or place orders.
   */
  pauseRunner(walletId: string): boolean {
    if (!this.runners.some((r) => r.walletId === walletId)) return false;
    this.pausedWallets.add(walletId);
    consoleLog.warn('ENGINE', `Runner paused: ${walletId}`, { walletId });
    return true;
  }

  /**
   * Resume a previously paused wallet runner.
   */
  resumeRunner(walletId: string): boolean {
    if (!this.pausedWallets.has(walletId)) return false;
    this.pausedWallets.delete(walletId);
    consoleLog.success('ENGINE', `Runner resumed: ${walletId}`, { walletId });
    return true;
  }

  /** Check whether a specific wallet runner is paused. */
  isRunnerPaused(walletId: string): boolean {
    return this.pausedWallets.has(walletId);
  }

  /** Return the set of all currently paused wallet IDs. */
  getPausedWallets(): Set<string> {
    return new Set(this.pausedWallets);
  }

  private tickCount = 0;
  private marketUpdateCount = 0;
  private lastScanLog = 0;

  private async tick(): Promise<void> {
    this.tickCount++;

    // Log a periodic scan summary every 12 ticks (~60 s at 5 s interval)
    if (this.tickCount % 12 === 0) {
      consoleLog.debug('ENGINE', `Tick #${this.tickCount} — ${this.runners.length} runners, ${this.stream.getAllMarkets().length} cached markets, ${this.marketUpdateCount} updates since last summary`);
      this.marketUpdateCount = 0;
    }

    for (const runner of this.runners) {
      if (this.pausedWallets.has(runner.walletId)) continue;  // skip paused
      runner.strategy.onTimer();
      await this.processSignals(runner);
    }
  }

  private handleMarketUpdate(data: MarketData): void {
    this.marketUpdateCount++;

    // Throttle per-market update logs to at most once every 30 s
    const now = Date.now();
    if (now - this.lastScanLog > 30_000) {
      consoleLog.debug('SCAN', `Market update: ${data.marketId?.slice(0, 12)}… — ${data.outcomes?.length ?? 0} outcomes`, {
        marketId: data.marketId,
        question: data.question?.slice(0, 80),
      });
      this.lastScanLog = now;
    }

    for (const runner of this.runners) {
      runner.strategy.onMarketUpdate(data);
    }
  }

  private async processSignals(runner: StrategyRunner): Promise<void> {
    const signals = await runner.strategy.generateSignals();
    if (signals.length > 0) {
      consoleLog.info('SIGNAL', `[${runner.strategy.name}] Generated ${signals.length} signal(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        signals: signals.map((s) => ({
          market: s.marketId.slice(0, 12) + '…',
          outcome: s.outcome,
          side: s.side,
          confidence: Number((s.confidence ?? 0).toFixed(3)),
          edge: Number((s.edge ?? 0).toFixed(4)),
        })),
      });
    }

    const orders = await runner.strategy.sizePositions(signals);
    if (orders.length > 0) {
      consoleLog.info('ORDER', `[${runner.strategy.name}] Sized ${orders.length} order(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        orders: orders.map((o) => ({
          market: o.marketId.slice(0, 12) + '…',
          outcome: o.outcome,
          side: o.side,
          price: o.price,
          size: o.size,
        })),
      });
    }

    for (const order of orders) {
      try {
        const executed = await this.orderRouter.route(order);
        if (executed) {
          runner.strategy.notifyFill(order);
          consoleLog.success('FILL', `[${runner.strategy.name}] Executed ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(4)}`, {
            walletId: order.walletId,
            strategy: order.strategy,
            marketId: order.marketId,
            outcome: order.outcome,
            side: order.side,
            price: order.price,
            size: order.size,
            cost: Number((order.price * order.size).toFixed(4)),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Order failed: ${msg}`, {
          walletId: order.walletId,
          marketId: order.marketId,
          error: msg,
        });
      }
    }

    await runner.strategy.managePositions();

    /* ── Route exit orders produced by managePositions() ── */
    const exitOrders = runner.strategy.drainExitOrders();
    if (exitOrders.length > 0) {
      consoleLog.info('ORDER', `[${runner.strategy.name}] ${exitOrders.length} exit order(s) for wallet ${runner.walletId}`, {
        walletId: runner.walletId,
        strategy: runner.strategy.name,
        exits: exitOrders.map((o) => ({
          market: o.marketId.slice(0, 12) + '…',
          outcome: o.outcome,
          side: o.side,
          price: o.price,
          size: o.size,
        })),
      });
    }

    for (const exitOrder of exitOrders) {
      try {
        const executed = await this.orderRouter.route(exitOrder);
        if (executed) {
          consoleLog.success('FILL', `[${runner.strategy.name}] Exited ${exitOrder.outcome} ×${exitOrder.size} @ $${exitOrder.price.toFixed(4)}`, {
            walletId: exitOrder.walletId,
            strategy: exitOrder.strategy,
            marketId: exitOrder.marketId,
            outcome: exitOrder.outcome,
            side: exitOrder.side,
            price: exitOrder.price,
            size: exitOrder.size,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        consoleLog.error('ORDER', `[${runner.strategy.name}] Exit order failed: ${msg}`, {
          walletId: exitOrder.walletId,
          marketId: exitOrder.marketId,
          error: msg,
        });
      }
    }
  }
}
