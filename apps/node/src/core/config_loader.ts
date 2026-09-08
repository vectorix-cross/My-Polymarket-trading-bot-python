import fs from 'fs';
import YAML from 'yaml';
import { AppConfig, RiskLimits, TradingMode } from '../types';

interface RawRiskLimits {
  max_position_size?: number;
  max_exposure_per_market?: number;
  max_daily_loss?: number;
  max_open_trades?: number;
  max_drawdown?: number;
}

interface RawConfig {
  environment?: { enable_live_trading?: boolean };
  wallets?: Array<{
    id: string;
    mode?: TradingMode;
    strategy: string;
    capital?: number;
    risk_limits?: RawRiskLimits;
  }>;
  strategy_config?: Record<string, Record<string, unknown>>;
  polymarket?: { gamma_api?: string; clob_api?: string };
}

const DEFAULT_LIMITS: RiskLimits = {
  maxPositionSize: 100,
  maxExposurePerMarket: 200,
  maxDailyLoss: 100,
  maxOpenTrades: 5,
  maxDrawdown: 0.2,
};

export function loadConfig(path: string): AppConfig {
  const raw = fs.readFileSync(path, 'utf8');
  const parsed = YAML.parse(raw) as RawConfig;

  const wallets = (parsed.wallets ?? []).map((wallet) => ({
    id: wallet.id,
    mode: wallet.mode ?? 'PAPER',
    strategy: wallet.strategy,
    capital: wallet.capital ?? 0,
    riskLimits: {
      ...DEFAULT_LIMITS,
      ...toRiskLimits(wallet.risk_limits),
    },
  }));

  const liveRequested = Boolean(parsed.environment?.enable_live_trading ?? false);
  const liveEnvEnabled = process.env.ENABLE_LIVE_TRADING === 'true';

  return {
    environment: {
      enableLiveTrading: liveRequested && liveEnvEnabled,
    },
    wallets,
    strategyConfig: parsed.strategy_config ?? {},
    polymarket: {
      gammaApi: parsed.polymarket?.gamma_api ?? 'https://gamma-api.polymarket.com',
      clobApi: parsed.polymarket?.clob_api ?? 'https://clob.polymarket.com',
    },
  };
}

function toRiskLimits(risk?: RawRiskLimits): Partial<RiskLimits> {
  if (!risk) return {};
  return {
    maxPositionSize: risk.max_position_size,
    maxExposurePerMarket: risk.max_exposure_per_market,
    maxDailyLoss: risk.max_daily_loss,
    maxOpenTrades: risk.max_open_trades,
    maxDrawdown: risk.max_drawdown,
  };
}
