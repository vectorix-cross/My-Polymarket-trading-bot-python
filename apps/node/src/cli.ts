import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { loadConfig } from './core/config_loader';
import { WalletManager } from './wallets/wallet_manager';
import { KillSwitch } from './risk/kill_switch';
import { RiskEngine } from './risk/risk_engine';
import { TradeExecutor } from './execution/trade_executor';
import { OrderRouter } from './execution/order_router';
import { Engine } from './core/engine';
import { listStrategies } from './strategies/registry';
import { computeAllPerformance } from './reporting/performance';
import { logger } from './reporting/logs';
import { DashboardServer } from './reporting/dashboard_server';
import { WhaleService } from './whales/whale_service';
import { WhaleAPI } from './whales/whale_api';
import { DEFAULT_WHALE_CONFIG, DEFAULT_SCANNER_CONFIG, DEFAULT_API_POOL_CONFIG, DEFAULT_FAST_SCAN_CONFIG, DEFAULT_EXCHANGE_SOURCES } from './whales/whale_types';
import type { WhaleTrackingConfig, ScannerConfig } from './whales/whale_types';

const program = new Command();
const statePath = path.resolve('.runtime/state.json');

/* ── Config normalization helpers ── */

/** Convert a snake_case string to camelCase */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Recursively convert all snake_case keys in a plain object to camelCase */
function deepSnakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(deepSnakeToCamel);
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[snakeToCamel(k)] = deepSnakeToCamel(v);
    }
    return out;
  }
  return obj;
}

/**
 * YAML scanner config uses human-friendly key names that differ from the
 * TypeScript ScannerConfig property names.  This explicit mapping handles
 * both the legacy snake_case YAML keys and any naming divergences.
 */
const SCANNER_KEY_MAP: Record<string, keyof ScannerConfig> = {
  // Direct camelCase matches (new YAML format)
  enabled:              'enabled',
  scanIntervalMs:       'scanIntervalMs',
  marketsPerScan:       'marketsPerScan',
  minMarketLiquidityUsd:'minMarketLiquidityUsd',
  minMarketVolume24hUsd:'minMarketVolume24hUsd',
  tradesPerMarket:      'tradesPerMarket',
  tradePageDepth:       'tradePageDepth',
  minAddressVolumeUsd:  'minAddressVolumeUsd',
  minAddressTrades:     'minAddressTrades',
  minWinRate:           'minWinRate',
  minRoi:               'minRoi',
  autoPromoteMinScore:  'autoPromoteMinScore',
  autoPromoteEnabled:   'autoPromoteEnabled',
  autoPromoteMaxPerScan:'autoPromoteMaxPerScan',
  bigTradeMinUsd:       'bigTradeMinUsd',
  crossRefEnabled:      'crossRefEnabled',
  crossRefMaxPerBatch:  'crossRefMaxPerBatch',
  clusterDetectionEnabled: 'clusterDetectionEnabled',
  clusterMinWhales:     'clusterMinWhales',
  clusterWindowHours:   'clusterWindowHours',
  parallelFetchBatch:   'parallelFetchBatch',
  // Legacy snake_case → camelCase aliases (backward compat)
  scanIntervalMs_:      'scanIntervalMs',       // auto-converted snake hits this
  topMarketsCount:      'marketsPerScan',
  minMarketVolumeUsd:   'minMarketVolume24hUsd',
  tradesPerMarketLimit: 'tradesPerMarket',
  minWhaleTrades:       'minAddressTrades',
  minWhaleVolumeUsd:    'minAddressVolumeUsd',
  minWhaleWinRate:      'minWinRate',
  minWhaleRoi:          'minRoi',
  autoTrackEnabled:     'autoPromoteEnabled',
  autoTrackMinScore:    'autoPromoteMinScore',
  autoTrackMaxPerScan:  'autoPromoteMaxPerScan',
};

/** Normalise a raw YAML scanner object into a proper ScannerConfig */
function normaliseScannerConfig(raw: Record<string, unknown>): ScannerConfig {
  // First convert any remaining snake_case keys to camelCase
  const camelRaw = deepSnakeToCamel(raw) as Record<string, unknown>;

  const out: Record<string, unknown> = { ...DEFAULT_SCANNER_CONFIG };
  for (const [key, value] of Object.entries(camelRaw)) {
    const mapped = SCANNER_KEY_MAP[key];
    if (mapped) {
      out[mapped] = value;
    }
  }

  /* ── Deep-merge nested config objects ── */

  // apiPool
  const apiPoolRaw = (camelRaw.apiPool ?? {}) as Record<string, unknown>;
  out.apiPool = {
    ...DEFAULT_API_POOL_CONFIG,
    ...apiPoolRaw,
    endpoints: Array.isArray(apiPoolRaw.endpoints) ? apiPoolRaw.endpoints : DEFAULT_API_POOL_CONFIG.endpoints,
  };

  // fastScan
  const fastScanRaw = (camelRaw.fastScan ?? {}) as Record<string, unknown>;
  out.fastScan = { ...DEFAULT_FAST_SCAN_CONFIG, ...fastScanRaw };

  // exchangeSources
  if (Array.isArray(camelRaw.exchangeSources)) {
    out.exchangeSources = camelRaw.exchangeSources;
  } else {
    out.exchangeSources = [...DEFAULT_EXCHANGE_SOURCES];
  }

  // Simple scalar fields that pass through unchanged
  if (camelRaw.backfillDays !== undefined) out.backfillDays = camelRaw.backfillDays;
  if (camelRaw.polygonRpcUrl !== undefined) out.polygonRpcUrl = camelRaw.polygonRpcUrl;
  if (camelRaw.usdcContractAddress !== undefined) out.usdcContractAddress = camelRaw.usdcContractAddress;
  if (camelRaw.networkGraphEnabled !== undefined) out.networkGraphEnabled = camelRaw.networkGraphEnabled;
  if (camelRaw.copySimEnabled !== undefined) out.copySimEnabled = camelRaw.copySimEnabled;
  if (camelRaw.copySimSlippageBps !== undefined) out.copySimSlippageBps = camelRaw.copySimSlippageBps;
  if (camelRaw.copySimDelaySeconds !== undefined) out.copySimDelaySeconds = camelRaw.copySimDelaySeconds;
  if (camelRaw.regimeAdaptiveEnabled !== undefined) out.regimeAdaptiveEnabled = camelRaw.regimeAdaptiveEnabled;

  return out as unknown as ScannerConfig;
}

/** Deep-merge a YAML whale_tracking block into WhaleTrackingConfig defaults */
function buildWhaleConfig(raw: Record<string, unknown>): WhaleTrackingConfig {
  // Convert top-level snake_case keys
  const camelRaw = deepSnakeToCamel(raw) as Record<string, unknown>;

  // Extract and normalise nested objects before the shallow merge
  const scannerRaw = (camelRaw.scanner ?? {}) as Record<string, unknown>;
  delete camelRaw.scanner;

  const copyRaw = (camelRaw.copy ?? {}) as Record<string, unknown>;
  delete camelRaw.copy;

  const scoreWeightsRaw = (camelRaw.scoreWeights ?? {}) as Record<string, unknown>;
  delete camelRaw.scoreWeights;

  return {
    ...DEFAULT_WHALE_CONFIG,
    ...camelRaw,
    scoreWeights: { ...DEFAULT_WHALE_CONFIG.scoreWeights, ...scoreWeightsRaw },
    copy: { ...DEFAULT_WHALE_CONFIG.copy, ...copyRaw },
    scanner: normaliseScannerConfig(scannerRaw),
  } as WhaleTrackingConfig;
}

type ConfigDocument = {
  wallets?: Array<{ id: string; mode?: string; strategy?: string; capital?: number }>;
  [key: string]: unknown;
};

function writeState(state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readState(): Record<string, unknown> {
  if (!fs.existsSync(statePath)) {
    return { status: 'stopped' };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
}

program
  .name('bot')
  .description('Polymarket multi-strategy trading platform')
  .version('0.1.0');

program
  .command('start')
  .description('Start the trading engine')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action(async (options: { config: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 3000);
    const dashboardServer = new DashboardServer(walletManager, dashboardPort);

    /* ── Whale Tracking Engine ── */
    const rawConfig = YAML.parse(fs.readFileSync(options.config, 'utf8')) as Record<string, unknown>;
    const whaleConfigRaw = (rawConfig.whale_tracking ?? {}) as Record<string, unknown>;
    const whaleConfig = buildWhaleConfig(whaleConfigRaw);
    logger.info({
      scannerEnabled: whaleConfig.scanner.enabled,
      marketsPerScan: whaleConfig.scanner.marketsPerScan,
      minLiquidity: whaleConfig.scanner.minMarketLiquidityUsd,
      minVolume24h: whaleConfig.scanner.minMarketVolume24hUsd,
    }, 'Whale config loaded');
    if (whaleConfig.enabled) {
      const clobApi = config.polymarket?.clobApi ?? 'https://clob.polymarket.com';
      const gammaApi = config.polymarket?.gammaApi ?? 'https://gamma-api.polymarket.com';
      const whaleService = new WhaleService(whaleConfig, clobApi, gammaApi);
      const whaleApi = new WhaleAPI(whaleService);
      dashboardServer.setWhaleApi(whaleApi);
      whaleService.start();
      logger.info('Whale Tracking Engine active');
    }

    dashboardServer.start();
    const killSwitch = new KillSwitch();
    const riskEngine = new RiskEngine(killSwitch);
    const orderRouter = new OrderRouter(walletManager, riskEngine, new TradeExecutor());

    const engine = new Engine(config, walletManager, orderRouter);
    await engine.initialize();
    dashboardServer.setEngine(engine);
    engine.start();

    writeState({ status: 'running', startedAt: new Date().toISOString() });
  });

program
  .command('stop')
  .description('Stop the trading engine')
  .action(() => {
    writeState({ status: 'stopped', stoppedAt: new Date().toISOString() });
    logger.info('Engine stop requested');
  });

program
  .command('status')
  .description('Get engine status')
  .action(() => {
    logger.info(readState());
  });

program
  .command('list-strategies')
  .description('List available strategies')
  .action(() => {
    logger.info({ strategies: listStrategies() });
  });

program
  .command('performance')
  .description('Show performance snapshot')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { config: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logger.info(computeAllPerformance(walletManager.listWallets()));
  });

program
  .command('paper-report')
  .description('Show paper trading report')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { config: string }) => {
    const config = loadConfig(options.config);
    const walletManager = new WalletManager();
    for (const wallet of config.wallets) {
      walletManager.registerWallet(wallet, wallet.strategy, config.environment.enableLiveTrading);
    }
    logger.info({ paperWallets: walletManager.listWallets().filter((w) => w.mode === 'PAPER') });
  });

program
  .command('add-wallet')
  .description('Add a wallet to the config file')
  .requiredOption('--id <id>', 'Wallet id')
  .requiredOption('--strategy <strategy>', 'Strategy name')
  .option('--mode <mode>', 'Trading mode (PAPER|LIVE)', 'PAPER')
  .option('--capital <capital>', 'Capital allocation', '0')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action(
    (options: {
      id: string;
      strategy: string;
      mode: string;
      capital: string;
      config: string;
    }) => {
    const raw = fs.readFileSync(options.config, 'utf8');
  const parsed = YAML.parse(raw) as ConfigDocument;
    parsed.wallets = parsed.wallets ?? [];
    parsed.wallets.push({
      id: options.id,
      mode: options.mode,
      strategy: options.strategy,
      capital: Number(options.capital),
    });
    fs.writeFileSync(options.config, YAML.stringify(parsed));
    logger.info({ walletId: options.id }, 'Wallet added');
  });

program
  .command('remove-wallet')
  .description('Remove a wallet from the config file')
  .requiredOption('--id <id>', 'Wallet id')
  .option('-c, --config <path>', 'Config path', 'config.yaml')
  .action((options: { id: string; config: string }) => {
    const raw = fs.readFileSync(options.config, 'utf8');
  const parsed = YAML.parse(raw) as ConfigDocument;
  parsed.wallets = (parsed.wallets ?? []).filter((wallet) => wallet.id !== options.id);
    fs.writeFileSync(options.config, YAML.stringify(parsed));
    logger.info({ walletId: options.id }, 'Wallet removed');
  });

program.parseAsync(process.argv);
