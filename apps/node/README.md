<div align="center">

# Vectorix Polymarket Node Engine

### TypeScript multi-strategy platform for Polymarket prediction markets (paper by default)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/Tests-106%20Passing-brightgreen?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-MIT-yellow?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Lines of Code](https://img.shields.io/badge/Lines%20of%20Code-53%2C776-informational)](src/)

**7 trading strategies · 🐋 whale tracker & copy-trade simulator · 📊 real-time dashboard · 🔒 paper trading by default**

[Features](#-features) · [Quick Start](#-quick-start) · [Strategies](#-strategies) · [Whale Scanner](#-whale-tracking--scanner) · [Dashboard](#-real-time-dashboard) · [Configuration](#%EF%B8%8F-configuration) · [API Reference](#-api-endpoints) · [Custom Development](#-custom-bot-development)

<br/>

<img src="docs/screenshots/dashboard.png" alt="Polymarket Trading Bot Dashboard — Real-time P&L tracking, 10 wallets, 8 strategies, whale scanner" width="100%" />

*Real-time dashboard showing 10 active wallets, $72,800 total capital, $39,240 total P&L, and 7 concurrent strategies running in paper trading mode.*

</div>

---

## 📖 Overview

A production-grade, modular trading system for [Polymarket](https://polymarket.com) prediction markets. Run **7 concurrent strategies** — from cross-market arbitrage to AI-driven forecasting — each isolated in its own wallet with independent capital, risk limits, and execution modes (LIVE or PAPER).

The platform includes an enterprise-level **whale tracking engine** that auto-discovers profitable traders, scores them with regime-adaptive algorithms, detects coordinated whale clusters, and lets you simulate copy-trading their moves — all from a beautiful real-time dashboard.

### Why This Bot?

| Problem | Solution |
|---------|----------|
| Manual trading is slow & emotional | 7 automated strategies scan 24/7, execute in milliseconds |
| Can't find alpha in prediction markets | Whale scanner discovers profitable traders with proven track records |
| Risk of ruin from a single bad trade | Per-wallet isolation, daily loss limits, global kill switch |
| No visibility into what the bot is doing | Real-time SSE dashboard with live trades, P&L, positions |
| Rate-limited by Polymarket APIs | Multi-API pool with rotation, 16x parallel scanning |
| Fear of losing real money while testing | Paper trading mode by default — no real funds at risk |

---

## ✨ Features

### 🧠 8 Built-In Trading Strategies

| # | Strategy | Type | Description | Edge |
|---|----------|------|-------------|------|
| 1 | **Cross-Market Arbitrage** | Arbitrage | Exploits price differences between correlated Polymarket markets | 3%+ minimum edge |
| 2 | **Mispricing Arbitrage** | Arbitrage | Detects when outcome probabilities don't sum to 100% | 2%+ dislocation |
| 3 | **Filtered High-Prob Convergence** | Convergence | 7-filter pipeline targeting 65-96% probability outcomes | 200 bps take profit |
| 4 | **Market Making (Spread)** | Market Making | Provides liquidity by quoting both sides of the book | 40 bps spread capture |
| 5 | **Momentum** | Trend Following | Rides short-term price trends with 15-min lookback | Trend continuation |
| 6 | **AI Forecast** | Research/AI | ML-driven predictions with web research pipeline | Data-driven alpha |
| 7 | **Copy Trading** | Whale Mirroring | Mirrors whale trades in real-time with full risk management | Whale alpha extraction |
| 8 | **User-Defined** | Custom | Your own strategy — extend the base class | Unlimited |

### 🐋 Whale Tracking & Copy Trading

- **Auto-Discovery Scanner** — Scans 50+ liquid markets per cycle to find profitable whales
- **16x Parallel Scanning** — Semaphore-based concurrency with tunable batch sizes
- **Multi-Dimensional Scoring** — Profitability (30%), timing skill (20%), low slippage (15%), consistency (15%), market selection (10%), recency (10%)
- **Regime-Adaptive Scoring** — Automatically adjusts whale scores based on current market conditions
- **Whale Cluster Detection** — Identifies when multiple whales converge on the same market
- **Network Graph Analysis** — Visualizes relationships between whale wallets
- **Copy-Trade Simulator** — Backtest copy-trading strategies with configurable slippage & delay
- **Big Trade Alerts** — Real-time alerts for trades ≥ $3K
- **Cross-Reference Engine** — Deep-scans top whales across all markets
- **Historical Backfill** — 7-day lookback on first run for immediate insights
- **On-Chain Balance Lookup** — USDC balance verification via Polygon RPC
- **Multi-Exchange Ready** — Stubs for Kalshi and Manifold Markets

### 📊 Real-Time Dashboard

- **Server-Sent Events (SSE)** — Live updates, no polling
- **Dark Theme UI** — Professional trading terminal aesthetic
- **10 Wallet Cards** — Each showing strategy, P&L, open positions, trade history
- **Strategy Library** — Browse all strategies, create wallets with one click
- **Live Trade Feed** — Every BUY/SELL across all wallets in real-time
- **Market Scanner View** — See which markets the bot is analyzing
- **Console Logs** — Live log stream from the engine
- **Whale Tracking Panel** with 6 sub-tabs:
  - 🔍 Scanner — Live scan results with whale profiles
  - 📊 Clusters — Coordinated whale activity detection
  - 🕸️ Network — Wallet relationship graph
  - 📈 Copy Sim — Copy-trade performance simulation
  - 🌊 Regime — Market regime analysis & adaptive scoring
  - 🔄 API Pool — Endpoint health & rate limit monitoring
- **Performance Metrics** — Markets/sec, trades/sec, fetch latency, cache hit rate

### 🔒 Risk Management

- **Wallet Isolation** — Each strategy runs in its own wallet with separate capital
- **Per-Wallet Limits** — Max position size, exposure per market, daily loss, max drawdown
- **Global Kill Switch** — Emergency stop across all strategies
- **Paper Trading Default** — LIVE mode requires explicit `ENABLE_LIVE_TRADING=true`
- **Daily/Weekly Loss Halts** — Auto-pause at configurable thresholds (3% daily, 8% weekly)
- **MLE Caps** — Maximum loss exposure capped at 5% per market, 15% total
- **Order Rate Limiting** — Prevents runaway order submission
- **No Secrets in Code** — All API keys via environment variables only

### ⚡ Performance & Scalability

- **50 TypeScript source files** — Clean, modular architecture
- **106 unit tests** — Full coverage with Vitest
- **16x parallel market scanning** — Configurable concurrency
- **Smart caching** — 5-minute TTL market metadata cache
- **API pool rotation** — Distribute requests across multiple endpoints
- **Docker-ready** — Single `docker build` & `docker run`
- **SQLite storage** — Zero-config whale database

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **npm** (comes with Node.js)
- **Git** ([download](https://git-scm.com/))

### Installation

```bash
# Clone the repository
git clone https://github.com/dylanpersonguy/Polymarket-Trading-Bot.git
cd Polymarket-Trading-Bot

# Install dependencies
npm install

# Build the project
npm run build
```

### Launch (Paper Trading — Safe by Default)

```bash
# Start the bot with default config (all wallets in PAPER mode)
npm start

# Or use the CLI directly
node dist/cli.js start --config config.yaml
```

The bot will start all 10 wallets (8 strategies), launch the whale scanner, and serve the dashboard at:

> **🌐 Dashboard: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)**

### Verify It's Working

```bash
# Check the dashboard
open http://localhost:3000/dashboard

# View engine status via API
curl http://localhost:3000/api/data | jq

# List all wallets
curl http://localhost:3000/api/wallets | jq

# View live trades
curl http://localhost:3000/api/trades/all | jq
```

---

## 🧠 Strategies

### 1. Cross-Market Arbitrage

Identifies price discrepancies between correlated Polymarket markets and captures the spread.

```yaml
strategy_config:
  cross_market_arbitrage:
    min_edge: 0.03  # Minimum 3% edge to trade
```

**Example:** Market A prices "Trump wins" at 52¢ while Market B prices "Trump nominee" at 48¢. If logically linked, the bot captures the 4% spread.

### 2. Mispricing Arbitrage

Detects when a market's outcome probabilities don't sum to 100% (minus the vig), indicating mispricing.

```yaml
strategy_config:
  mispricing_arbitrage:
    min_dislocation: 0.02  # 2% minimum dislocation
```

**Example:** A binary market shows YES at 55¢ and NO at 42¢ (total = 97¢). The bot buys the underpriced side.

### 3. Filtered High-Probability Convergence

The flagship strategy. A rule-based, no-AI approach that targets markets where the leading outcome has a 65-96% probability AND passes 7 strict filters:

| Filter | What It Checks |
|--------|---------------|
| Liquidity | ≥ $10K market liquidity + depth within 1% of mid |
| Probability Band | Leading outcome between 65% and 96% |
| Spread | Bid-ask spread ≤ 200 bps |
| Time-to-Resolution | Market resolves within 14 days |
| Anti-Chasing | No recent 8%+ price spikes |
| Flow/Pressure | Orderbook imbalance or net buy flow ≥ $500 |
| Cluster Exposure | ≤ 25% capital in correlated markets |

**Sizing:** `position = capital × 0.5% × setup_score` where setup_score is a composite of spread tightness (30%), depth (25%), order flow (25%), and time-to-resolution (20%).

**Example:** Market "Will inflation drop below 3%?" — probability at 78%, spread at 120 bps, $50K liquidity, resolves in 9 days, strong buy flow. Setup score = 0.82. On $10K capital: position = $10,000 × 0.005 × 0.82 = **$41 entry**, targeting **200 bps ($0.82) profit**.

### 4. Market Making (Spread Strategy)

Quotes both sides of the orderbook, capturing the bid-ask spread. Works best in liquid, stable markets.

```yaml
strategy_config:
  market_making:
    spread_bps: 40  # 40 bps spread target
```

**Example:** Quoting 72¢ bid / 72.4¢ ask on a high-volume market, capturing 0.4¢ per round-trip.

### 5. Momentum

Rides short-term price trends using a 15-minute lookback window.

```yaml
strategy_config:
  momentum:
    lookback_minutes: 15
```

**Example:** Detects a market moving from 45¢ → 52¢ in 15 minutes with increasing volume. Enters a BUY, riding the momentum.

### 6. AI Forecast

ML-driven strategy that combines web research with quantitative analysis to forecast market outcomes.

```yaml
strategy_config:
  ai_forecast:
    refresh_minutes: 30  # Re-analyze every 30 minutes
```

### 7. Copy Trading

Mirrors trades from configured whale addresses in near-real-time with comprehensive risk management. Supports multiple whales, three sizing modes, and automatic exit when the whale closes their position.

**Key Features:**
- **Multi-whale following** — Track any number of wallet addresses simultaneously
- **Mirror / Inverse modes** — Copy whales directly or trade against them (contrarian)
- **3 sizing modes** — Fixed size, proportional to whale's trade, or half-Kelly
- **Full exit management** — Take profit, stop loss, trailing stop, time exit, whale-exit mirroring
- **Per-whale performance tracking** — Win rate, P&L, and consecutive loss cooldowns
- **Drawdown circuit breaker** — Auto-pauses copy trading when drawdown limit hit
- **Daily volume caps** — Prevents over-exposure from high-frequency whales
- **Market blacklist/whitelist** — Fine-grained control over which markets to copy

```yaml
strategy_config:
  copy_trade:
    whale_addresses:
      - "0xYourWhaleAddressHere"
    copy_mode: mirror              # mirror | inverse
    size_mode: fixed               # fixed | proportional | kelly
    fixed_size: 10
    max_open_positions: 15
    take_profit_bps: 150
    stop_loss_bps: 100
    trailing_stop_activate_bps: 80
    exit_on_whale_exit: true
    max_drawdown_pct: 0.15
    max_daily_volume_usd: 5000
```

### 8. User-Defined Strategy

A template for building your own custom strategy. Extend the `BaseStrategy` class:

```typescript
// src/strategies/custom/user_defined_strategy.ts
export class UserDefinedStrategy extends BaseStrategy {
  async evaluate(market: MarketData): Promise<Signal | null> {
    // Your custom logic here
  }
}
```

---

## 🐋 Whale Tracking & Scanner

The whale tracking engine is a self-contained system that discovers, scores, and monitors profitable Polymarket traders.

### How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Market Scanner  │────▶│  Trade Analyzer   │────▶│  Whale Scorer   │
│  50 markets/cycle│     │  Volume + Win Rate│     │  6-dimension    │
│  16x parallel    │     │  ROI calculation  │     │  composite score│
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                                                │
         ▼                                                ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Fast Scan Mode  │     │  Cluster Detect   │     │  Copy Simulator │
│  60s interval    │     │  2+ whales same   │     │  Backtest with  │
│  Top 5 markets   │     │  market = cluster │     │  slippage model │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Scanner Configuration

```yaml
whale_tracking:
  scanner:
    enabled: true
    scanIntervalMs: 600000           # Scan every 10 minutes
    marketsPerScan: 50               # Top 50 liquid markets
    parallelFetchBatch: 16           # 16 concurrent fetches
    minMarketVolume24hUsd: 10000     # Skip low-volume markets
    autoPromoteEnabled: true         # Auto-track high-scoring whales
    autoPromoteMinScore: 60          # Minimum score to auto-track
    clusterDetectionEnabled: true    # Detect whale herds
    networkGraphEnabled: true        # Map whale relationships
    copySimEnabled: true             # Simulate copy trading
    regimeAdaptiveEnabled: true      # Adjust scores by regime
```

### Scoring System

Each whale is scored on 6 dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Profitability | 30% | Historical P&L and ROI |
| Timing Skill | 20% | Entry/exit timing relative to price moves |
| Low Slippage | 15% | Execution quality and market impact |
| Consistency | 15% | Win rate stability over time |
| Market Selection | 10% | Quality of markets chosen |
| Recency/Activeness | 10% | Recent trading activity |

### API Pool (Rate Limit Bypass)

Distribute API requests across multiple endpoints to multiply throughput:

```yaml
whale_tracking:
  scanner:
    apiPool:
      enabled: true
      selectionStrategy: least-loaded  # round-robin | least-loaded | weighted-random
      endpoints:
        - name: custom-proxy
          url: https://your-proxy.example.com
          type: data-api
          maxRequestsPerMinute: 60
```

---

## 📊 Real-Time Dashboard

The dashboard is served as a single-page app at `http://localhost:3000/dashboard` with **Server-Sent Events** for real-time updates (no WebSocket dependencies).

### Dashboard Sections

| Section | Description |
|---------|-------------|
| **📈 Overview** | Engine status, total P&L, active wallets, market count |
| **💼 Wallets** | 10 wallet cards with strategy, capital, P&L, positions, trades |
| **🧠 Strategy Library** | Browse all 8 strategies, view details, create wallets |
| **📋 Trade Feed** | Live stream of all BUY/SELL signals across wallets |
| **🔍 Market Scanner** | Currently analyzed markets with prices and volume |
| **🐋 Whale Tracker** | Full whale tracking panel with 6 sub-tabs |
| **📊 Performance** | Scanner speed metrics, cache hits, API health |
| **🖥️ Console** | Live log stream from the engine |

### Wallet Management (via Dashboard)

- ✅ Create new wallets with any strategy
- ✅ Pause/resume individual wallets
- ✅ Delete wallets
- ✅ View detailed P&L, positions, and trade history
- ✅ Edit wallet settings (capital, risk limits)
- ✅ Custom wallet display names

---

## 🔌 API Endpoints

The bot exposes a full REST API:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard` | GET | Full dashboard HTML |
| `/api/data` | GET | Engine status + summary data |
| `/api/wallets` | GET | List all wallets |
| `/api/wallets` | POST | Create a new wallet |
| `/api/wallets/:id` | DELETE | Remove a wallet |
| `/api/wallets/:id/detail` | GET | Detailed wallet view |
| `/api/wallets/:id/pause` | POST | Pause a wallet |
| `/api/wallets/:id/resume` | POST | Resume a wallet |
| `/api/wallets/display-names` | GET | Wallet display names |
| `/api/strategies` | GET | List all strategies |
| `/api/strategies/:id` | GET | Strategy details |
| `/api/trades/all` | GET | All trades across wallets |
| `/api/trades/:walletId` | GET | Trades for a specific wallet |
| `/api/markets` | GET | Scanned markets data |
| `/api/whales/*` | GET | Whale tracking endpoints |
| `/api/console/stream` | GET | SSE live log stream |
| `/api/console/logs` | GET | Historical log entries |

---

## 🛠️ CLI Commands

```bash
# Start the trading engine
bot start --config config.yaml

# Check status
bot status

# Stop all strategies
bot stop

# Add a new wallet
bot add-wallet --config config.yaml

# Remove a wallet
bot remove-wallet --id wallet_1 --config config.yaml

# List available strategies
bot list-strategies

# View performance report
bot performance

# Paper trading report
bot paper-report
```

---

## ⚙️ Configuration

All configuration lives in `config.yaml`. Here's the structure:

### Environment

```yaml
environment:
  enable_live_trading: false  # PAPER mode by default — safety first
```

### Wallets

```yaml
wallets:
  - id: paper_convergence
    mode: PAPER                  # PAPER or LIVE
    strategy: filtered_high_prob_convergence
    capital: 10000               # $10,000 starting capital
    risk_limits:
      max_position_size: 500     # Max $500 per position
      max_exposure_per_market: 1000
      max_daily_loss: 500        # Stop at $500 daily loss
      max_open_trades: 50
      max_drawdown: 0.10         # 10% max drawdown
```

### Enabling LIVE Trading

```bash
# LIVE trading requires explicit opt-in via environment variable
ENABLE_LIVE_TRADING=true npm start
```

> ⚠️ **Warning:** LIVE mode executes real trades with real funds. Start with PAPER mode to validate your strategy first.

---

## 🏗️ Architecture

```
src/
├── core/                    # Engine, config loader, scheduler
│   ├── engine.ts            # Main orchestrator
│   ├── config_loader.ts     # YAML config parser
│   └── scheduler.ts         # Strategy scheduling loop
├── strategies/              # 8 pluggable strategies
│   ├── strategy_interface.ts
│   ├── registry.ts
│   ├── arbitrage/           # Cross-market & mispricing
│   ├── convergence/         # High-probability convergence
│   ├── copy_trading/        # Whale copy trading
│   ├── market_making/       # Spread capture
│   ├── trend/               # Momentum following
│   ├── research_ai/         # AI + web research
│   └── custom/              # User-defined template
├── execution/               # Order routing & position management
├── risk/                    # Risk engine, exposure limits, kill switch
├── wallets/                 # Wallet manager, paper & Polymarket wallets
├── whales/                  # Whale scanner, scoring, clusters, network
├── paper_trading/           # Fill simulator, P&L tracker, slippage model
├── reporting/               # Dashboard server, logging, performance
├── storage/                 # SQLite database & models
└── data/                    # Market fetcher, orderbook, trade history
```

**Key Design Decisions:**
- **Wallet isolation** — Each strategy operates in a sandboxed wallet
- **Event-driven** — SSE for dashboard, signal-based execution
- **Pluggable strategies** — Extend `BaseStrategy` for custom logic
- **Paper-first** — Everything defaults to simulation mode
- **Zero external services** — SQLite, no Redis/Postgres/RabbitMQ required

---

## 🧪 Testing

```bash
# Run all 106 tests
npm test

# Run with verbose output
npx vitest run --reporter=verbose

# Run specific test file
npx vitest run tests/whale_scanner.test.ts

# Type checking
npm run typecheck
```

**Test coverage includes:**
- Wallet manager (creation, isolation, limits)
- Order router (routing, execution, fills)
- Risk engine (limits, kill switch, drawdown)
- Whale scanner (discovery, scoring, clustering)
- Whale DB (storage, queries, leaderboard)
- Whale analytics (metrics, performance)
- Convergence strategy (filters, sizing, signals)

---

## 🐳 Docker

```bash
# Build the image
docker build -t polymarket-bot .

# Run in paper trading mode
docker run -p 3000:3000 polymarket-bot

# Run with live trading enabled
docker run -p 3000:3000 -e ENABLE_LIVE_TRADING=true polymarket-bot
```

---

## 📈 Profitability & Examples

### Strategy Performance Characteristics

| Strategy | Target Return | Win Rate Target | Risk/Reward | Best Market Conditions |
|----------|--------------|-----------------|-------------|----------------------|
| Cross-Market Arb | 3-5% per trade | 70%+ | 2:1 | Correlated markets with price divergence |
| Mispricing Arb | 2-4% per trade | 75%+ | 3:1 | Markets with probability sum ≠ 100% |
| Convergence | 2% (200 bps) | 60-70% | 1.3:1 | High-prob markets near resolution |
| Market Making | 0.4% per round-trip | 55%+ | 1:1 | Stable, liquid markets |
| Momentum | 5-15% on trends | 45-55% | 2:1 | Trending markets with volume |
| AI Forecast | Variable | Variable | Variable | Data-rich markets |
| Whale Copy | Mirrors whale P&L | Whale-dependent | Whale-dependent | When top whales are active |

### Example Trade Flow

```
[12:03:45] 🔍 Scanning 50 markets (16 parallel)...
[12:03:47] ✅ Market "Will BTC hit $100K by Dec?" passed all 7 filters
           Prob: 72% | Spread: 85 bps | Liquidity: $125K | Resolves: 8 days
[12:03:47] 📊 Setup Score: 0.87 (spread=0.92, depth=0.85, flow=0.88, time=0.80)
[12:03:47] 💰 Position: $10,000 × 0.5% × 0.87 = $43.50
[12:03:47] 📝 BUY 60 shares @ $0.725 (limit, post-only)
[12:03:48] ✅ FILLED: 60 shares @ $0.725 = $43.50
[12:05:12] 📈 Price moved to $0.745 (+200 bps) → TAKE PROFIT triggered
[12:05:12] 📝 SELL 60 shares @ $0.745
[12:05:12] ✅ FILLED: Profit = $1.20 (+2.76% on position)
```

### Risk Guardrails in Action

```
[14:22:01] ⚠️ Daily loss at 2.8% ($280) — approaching 3% limit
[14:35:15] 🛑 Daily loss hit 3.0% — ALL strategies PAUSED for today
[14:35:15] 📊 Weekly P&L: +$420 (+4.2%) — well within 8% drawdown limit
```

---

## 🔐 Security

- ✅ No API keys or secrets in the codebase
- ✅ All credentials via environment variables
- ✅ Private keys are never logged
- ✅ PAPER mode by default
- ✅ LIVE trading requires explicit opt-in
- ✅ Audited for secret exposure before publication

---

## 📬 Custom Bot Development

**Want a custom trading bot tailored to your strategy?**

I build custom automated trading bots for prediction markets, crypto, and forex. Whether you need modifications to this platform or an entirely new system, I can help.

| Channel | Link |
|---------|------|
| **Email** | [vanjasretenovic4@gmail.com](mailto:vanjasretenovic4@gmail.com) |
| **Telegram** | [@vectoris_corss](https://t.me/vectoris_corss) |
| **GitHub** | [vectorix-cross](https://github.com/vectorix-cross) |

Services include:
- Custom strategy development & backtesting
- Live trading integration with exchange APIs
- Risk management system design
- Dashboard & monitoring tools
- Performance optimization & scaling

---

## 📄 License

This project is open-source under the [MIT License](LICENSE).

---

## 🌟 Star This Repo

If you find this project useful, please ⭐ star the repo — it helps others discover it!

---

<div align="center">

**Vectorix** (`vectorix-cross`) · Novi Sad

*51 source files · 21,000+ lines of code · 144 tests · 8 strategies · 1 mission: automate alpha*

</div>
