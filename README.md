# 0xTools - Solidity Developer Toolkit

[![Version](https://img.shields.io/visual-studio-marketplace/v/0xshubhs.0xtools?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.0xtools)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/0xshubhs.0xtools?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.0xtools)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/0xshubhs.0xtools?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=0xshubhs.0xtools)
[![Build Status](https://img.shields.io/github/actions/workflow/status/0xshubhs/0xtools/pr-validation.yml?branch=main&style=flat-square)](https://github.com/0xshubhs/0xtools/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

A professional VS Code extension and CLI tool for automatically scanning and generating method signatures from Solidity smart contracts in Foundry and Hardhat projects.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [VS Code Extension](#vs-code-extension)
  - [Command Line Interface](#command-line-interface)
- [Output Structure](#output-structure)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Overview

0xTools is a developer tool designed to streamline smart contract development by automatically extracting and organizing function signatures, events, and custom errors from Solidity contracts. It supports both Foundry and Hardhat project structures and provides organized output that can be used for testing, documentation, and contract interaction.

## Features

### Core Functionality

- **Automatic Contract Detection**: Recursively scans your project for Solidity files
- **Intelligent Categorization**: Separates contracts, libraries, and tests automatically
- **Signature Extraction**: Extracts function selectors, event signatures, and error signatures
- **Multiple Export Formats**: Generates JSON, TXT, CSV, and Markdown outputs
- **Deduplication**: Eliminates duplicate signatures across your codebase
- **Project-Aware**: Creates output in the correct project root directory

### Advanced Analysis Features

- **Real-time Gas Analysis**: Instant gas estimation with inline annotations and hover details
- **Two-tier Analysis**: Fast heuristic analysis (under 5ms) with optional solc compilation for accuracy
- **Storage Layout Analyzer**: Visualize storage slots, detect packing opportunities, estimate SSTORE/SLOAD costs
- **Function Call Graph**: Analyze call hierarchies, detect recursion, track external calls
- **Deployment Cost Estimator**: Calculate contract creation gas and costs at different gas prices
- **Gas Regression Tracker**: Compare gas usage across git branches and commits
- **Runtime Profiler**: Parse forge test reports and compare actual vs estimated gas
- **ABI Generation**: Transform signatures into standard Ethereum ABI format
- **Contract Size Check**: Verify contracts stay within 24KB deployment limit
- **Complexity Analysis**: Calculate cyclomatic and cognitive complexity metrics
- **Performance Caching**: SHA-256 based cache with intelligent invalidation

### Real-time Analysis Engine

The extension uses solc for accurate gas analysis:

**Compilation with Optimization**
- Full solc analysis runs on every file open and change
- Compilation runs with optimization enabled for accurate estimates
- Content-hash based caching prevents redundant analysis for unchanged code
- Provides accurate gas estimates and warnings

**Extended Analysis (Automatic Background)**
- Runs automatically after main analysis completes when resources are available
- Monitors memory usage (< 500MB) and CPU before running
- Includes storage layout, call graph, and deployment cost analysis
- Sequential execution with delays prevents resource spikes
- Never blocks main analysis or editing experience

**Performance Features:**
- Automatic resource monitoring prevents execution during heavy load
- Extended features run intelligently in background when system is idle
- Intelligent caching prevents redundant analysis
- Manual commands available for immediate analysis when needed

### Developer Experience

- **File Watching**: Automatically regenerates signatures when contracts change
- **Tree View Integration**: Browse signatures directly in VS Code sidebar
- **Command Palette**: Quick access to all scanning and analysis functions
- **CLI Support**: Integrate into build scripts and CI/CD pipelines
- **Configurable Filtering**: Control visibility levels (public, external, internal, private)
- **Lightweight**: Optimized package size, extended analysis runs only when requested
- **Non-blocking**: Heavy operations never interfere with realtime gas estimation

### Supported Project Types

- Foundry projects (foundry.toml)
- Hardhat projects (hardhat.config.js/ts)
- Mixed and monorepo structures

**For detailed feature documentation, see [FEATURES.md](FEATURES.md)**

## Installation

### From VS Code Marketplace

1. Open Visual Studio Code
2. Press `Ctrl+P` (Windows/Linux) or `Cmd+P` (macOS)
3. Type: `ext install 0xshubhs.0xtools`
4. Press Enter

### From VSIX File

```bash
code --install-extension 0xtools-0.3.0.vsix
```

### Command Line Installation

```bash
# Install globally via npm
npm install -g sigscan

# Or use directly with npx
npx sigscan scan ./my-project
```

## Usage

### VS Code Extension

#### Quick Start

1. Open a Foundry or Hardhat project in VS Code
2. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
3. Type "0xTools: Scan Project"
4. Signatures will be generated in `<project-root>/signatures/`

#### Available Commands

**Basic Operations:**
- **0xTools: Scan Project** - Scan all contracts in the current project
- **0xTools: Export Signatures** - Export signatures to specific format
- **0xTools: Start/Stop Watching** - Enable/disable automatic rescanning
- **0xTools: Refresh Signatures** - Manually refresh signature tree view
- **0xTools: Toggle Real-time Gas Analysis** - Enable/disable inline gas annotations

**Advanced Analysis:**

These features run automatically in the background after main analysis completes, when system resources are available:
- **Storage Layout Analysis** - Analyzes storage slot allocation and packing opportunities
- **Function Call Graph** - Maps function call dependencies and detects recursion
- **Deployment Cost Estimation** - Calculates deployment gas and ETH costs

Manual commands are also available for immediate execution:
- **0xTools: Show Storage Layout Analysis** - View storage layout report
- **0xTools: Show Function Call Graph** - View call graph visualization
- **0xTools: Show Deployment Cost Estimate** - View deployment cost breakdown
- **0xTools: Compare Gas with Branch** - Compare gas usage with another git branch (requires git)
- **0xTools: Show Runtime Profiler Report** - Compare estimated vs actual gas from forge tests (requires Foundry)

**Additional Analysis Tools:**
- **0xTools: Generate ABI** - Create ABI files from extracted signatures
- **0xTools: Estimate Gas** - Analyze and estimate gas costs for functions
- **0xTools: Check Contract Size** - Verify contract sizes against 24KB limit
- **0xTools: Analyze Complexity** - Calculate code complexity metrics
- **0xTools: Generate All Reports** - Run complete analysis suite

**How It Works:**
Extended analysis features (storage layout, call graph, deployment) automatically run in the background after each successful compilation when:
- Main solc analysis is complete
- Memory usage is below 500MB
- CPU is not heavily loaded
- No other analysis is in progress

This ensures zero impact on your editing experience while providing comprehensive insights automatically.

#### Tree View

Access the 0xTools sidebar to:
- Browse contracts by category (contracts, libraries, tests)
- View function signatures and selectors
- Copy selectors to clipboard
- Navigate to contract definitions

### Command Line Interface

#### Basic Usage

```bash
# Scan current directory
sigscan scan

# Scan specific project
sigscan scan /path/to/project

# Watch mode for continuous scanning
sigscan watch /path/to/project

# Export to specific format
sigscan export --format json /path/to/project
sigscan export --format txt /path/to/project
```

#### CLI Options

```
Options:
  -o, --output <path>         Output directory (default: ./signatures)
  -f, --format <type>         Export format: json, txt, or both (default: both)
  -w, --watch                 Watch mode for automatic rescanning
  -i, --include-internal      Include internal functions
  -p, --include-private       Include private functions
  --no-dedupe                 Disable signature deduplication
  -v, --verbose               Verbose logging
  -h, --help                  Display help information
```

#### Integration Examples

**Package.json Script:**
```json
{
  "scripts": {
    "signatures": "sigscan scan",
    "signatures:watch": "sigscan watch"
  }
}
```

**CI/CD Pipeline:**
```yaml
- name: Generate Signatures
  run: npx sigscan scan --format json
  
- name: Upload Signatures
  uses: actions/upload-artifact@v3
  with:
    name: contract-signatures
    path: signatures/
```

## Output Structure

0xTools generates organized signature files in your project's `signatures/` directory:

```
signatures/
├── signatures_2025-11-30T12-00-00.json
├── signatures_2025-11-30T12-00-00.txt
└── signatures-contracts.json (latest symlink)
```

## Example Projects

The `examples/` directory contains complete sample projects demonstrating best practices and folder structure conventions with production-grade contracts:

### Foundry Projects

**foundry-defi/** - DeFi Protocol Example
```
foundry-defi/
├── foundry.toml
├── src/
│   ├── LiquidityPool.sol      # AMM liquidity pool implementation
│   └── StakingRewards.sol     # Token staking with rewards
├── lib/
│   └── SafeMath.sol            # Math utility library
├── test/
│   └── LiquidityPool.t.sol    # Contract tests
└── signatures/
    ├── signatures_2025-11-30T12-00-00.json
    └── signatures_2025-11-30T12-00-00.txt
```

Features demonstrated:
- AMM liquidity pool with swap functionality
- Staking rewards distribution system
- Library usage and organization
- Comprehensive function signatures
- Event and error definitions

**foundry-dao/** - Advanced DAO Governance System
```
foundry-dao/
├── foundry.toml
├── src/
│   ├── GovernanceToken.sol     # ERC20 with delegation & checkpoints
│   ├── GovernorAlpha.sol       # On-chain governance
│   ├── Timelock.sol            # Delayed execution
│   └── Treasury.sol            # DAO fund management
├── test/
│   └── Governance.t.sol        # Governance tests
└── signatures/
    ├── signatures_2025-11-30T16-00-00.json
    └── signatures_2025-11-30T16-00-00.txt
```

Features demonstrated:
- Vote delegation with checkpoint system
- Proposal lifecycle management (propose, vote, queue, execute)
- Binary search for historical vote queries
- EIP-712 signature support for gasless voting
- Timelock with grace period and delay controls
- Treasury with budget management and spending proposals
- Complex state machine patterns
- Advanced access control and security mechanisms

**foundry-options/** - Options Trading Protocol
```
foundry-options/
├── foundry.toml
├── src/
│   ├── OptionsMarket.sol       # Options writing and trading
│   └── VolatilityOracle.sol    # Implied volatility tracking
├── test/
│   └── OptionsMarket.t.sol     # Options tests
└── signatures/
    ├── signatures-contracts.json
    └── signatures-contracts.txt
```

Features demonstrated:
- Call and put option contracts
- Black-Scholes pricing model implementation
- Collateral management with margin requirements
- Option lifecycle (write, buy, exercise, expire)
- Volatility oracle with historical price tracking
- Premium calculation with time decay
- Intrinsic and time value calculations
- Advanced mathematical operations (square root for volatility)

**foundry-oracle/** - Multi-Source Price Oracle
```
foundry-oracle/
├── foundry.toml
├── src/
│   ├── PriceAggregator.sol     # Multi-oracle price aggregation
│   └── ChainlinkAdapter.sol    # Chainlink feed adapter
├── test/
│   └── PriceAggregator.t.sol   # Oracle tests
└── signatures/
    ├── signatures-contracts.json
    └── signatures-contracts.txt
```

Features demonstrated:
- Median price calculation from multiple sources
- Weighted price aggregation
- Outlier detection and circuit breaker
- Heartbeat monitoring for stale prices
- Oracle reputation system with success/failure tracking
- Deviation calculations and confidence scoring
- Emergency stop mechanism
- Statistical functions (median, standard deviation)

### Hardhat Projects

**hardhat-nft/** - NFT Marketplace Example
```
hardhat-nft/
├── hardhat.config.js
├── contracts/
│   ├── ERC721A.sol             # Optimized NFT implementation
│   └── NFTMarketplace.sol      # Marketplace with auctions
├── test/
│   └── ERC721A.test.js         # Contract tests
└── signatures/
    ├── signatures_2025-11-30T14-30-00.json
    └── signatures_2025-11-30T14-30-00.txt
```

Features demonstrated:
- ERC721A batch minting optimization
- NFT marketplace with listing and auction support
- Complex contract interactions
- Structured event emissions
- Custom error handling

**hardhat-marketplace/** - Advanced Trading Platform
```
hardhat-marketplace/
├── hardhat.config.js
├── contracts/
│   ├── OrderBook.sol           # Decentralized order book exchange
│   └── LendingPool.sol         # Variable rate lending protocol
├── test/
│   └── OrderBook.test.js       # Exchange tests
└── signatures/
    ├── signatures_2025-11-30T18-00-00.json
    └── signatures_2025-11-30T18-00-00.txt
```

Features demonstrated:
- Limit and market order matching engine
- Order book depth and best bid/ask queries
- Variable interest rate calculations
- Utilization-based rate curves
- Liquidation mechanism for undercollateralized positions
- Health factor calculations
- Fee collection and distribution
- Complex state management with multiple data structures

**hardhat-bridge/** - Cross-Chain Bridge Infrastructure
```
hardhat-bridge/
├── hardhat.config.js
├── contracts/
│   ├── CrossChainBridge.sol    # Multi-sig bridge with validation
│   └── RelayerNetwork.sol      # Decentralized relayer system
├── test/
│   └── Bridge.test.js          # Bridge tests
└── signatures/
    ├── signatures_2025-11-30T19-00-00.json
    └── signatures_2025-11-30T19-00-00.txt
```

Features demonstrated:
- Multi-signature validation with weighted voting
- Validator network with reputation system
- Transfer lifecycle management (pending, validated, completed)
- Timeout and cancellation mechanisms
- Relayer staking and slashing
- Message delivery with cryptographic proofs
- Cross-chain communication patterns
- Dispute resolution system
- Dynamic threshold calculations

**hardhat-amm/** - Concentrated Liquidity AMM
```
hardhat-amm/
├── hardhat.config.js
├── contracts/
│   ├── ConcentratedLiquidity.sol  # Uniswap V3 style AMM
│   └── RouterV3.sol                # Multi-hop swap router
├── test/
│   └── ConcentratedLiquidity.test.js
└── signatures/
    ├── signatures-contracts.json
    └── signatures-contracts.txt
```

Features demonstrated:
- Tick-based concentrated liquidity positions
- Position management (mint, burn, collect fees)
- Fee growth tracking per position
- Multi-hop swap routing with path encoding
- Price oracle with time-weighted average prices (TWAP)
- Liquidity range management
- SqrtPriceX96 math for precision
- Gas-optimized position updates
- Complex data structure handling (nested mappings)

### Running Examples

```bash
# Scan the DeFi example
cd examples/foundry-defi
sigscan scan

# Scan the DAO governance example
cd examples/foundry-dao
sigscan scan

# Scan the options trading example
cd examples/foundry-options
sigscan scan

# Scan the oracle aggregator example
cd examples/foundry-oracle
sigscan scan

# Scan the NFT marketplace example
cd examples/hardhat-nft
sigscan scan

# Scan the trading platform example
cd examples/hardhat-marketplace
sigscan scan

# Scan the bridge example
cd examples/hardhat-bridge
sigscan scan

# Scan the concentrated liquidity AMM example
cd examples/hardhat-amm
sigscan scan

# Watch mode for development
sigscan watch
```

### JSON Format

```json
{
  "metadata": {
    "generatedAt": "2025-11-30T12:00:00.000Z",
    "projectType": "foundry",
    "totalContracts": 5,
    "totalFunctions": 25,
    "totalEvents": 8,
    "totalErrors": 3
  },
  "contracts": {
    "SimpleToken": {
      "path": "src/SimpleToken.sol",
      "category": "contracts",
      "functions": [
        {
          "name": "transfer",
          "signature": "transfer(address,uint256)",
          "selector": "0xa9059cbb",
          "visibility": "public"
        }
      ],
      "events": [
        {
          "name": "Transfer",
          "signature": "Transfer(address,address,uint256)",
          "hash": "0xddf252ad..."
        }
      ]
    }
  }
}
```

### TXT Format

```
# Contract Signatures
# Generated: 2025-11-30T12:00:00.000Z

## SimpleToken (src/SimpleToken.sol)

### Functions
transfer(address,uint256) -> 0xa9059cbb
approve(address,uint256) -> 0x095ea7b3
balanceOf(address) -> 0x70a08231

### Events
Transfer(address,address,uint256) -> 0xddf252ad...
Approval(address,address,uint256) -> 0x8c5be1e5...
```

## Configuration

### VS Code Settings

Configure 0xTools through VS Code settings (File > Preferences > Settings):

```json
{
  "sigscan.autoScan": true,
  "sigscan.watchMode": false,
  "sigscan.includeInternal": false,
  "sigscan.includePrivate": false,
  "sigscan.outputFormat": "both",
  "sigscan.deduplicate": true,
  "sigscan.excludePaths": ["node_modules", "lib"]
}
```

### Configuration File

Create a `.sigscanrc.json` in your project root:

```json
{
  "includeInternal": false,
  "includePrivate": false,
  "outputFormat": "both",
  "deduplicate": true,
  "excludePaths": [
    "node_modules",
    "lib",
    "cache"
  ]
}
```

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/0xshubhs/0xtools.git
cd 0xtools

# Install dependencies
npm install

# Build the extension
npm run compile

# Run tests
npm test

# Package the extension
npm run package
```

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Project Structure

```
0xtools/
├── src/
│   ├── cli/              # Command-line interface
│   ├── core/             # Core scanning logic
│   │   ├── parser.ts     # Solidity parser
│   │   ├── scanner.ts    # Project scanner
│   │   ├── exporter.ts   # Signature exporter
│   │   └── watcher.ts    # File watcher
│   ├── extension/        # VS Code extension
│   │   ├── extension.ts  # Extension entry point
│   │   ├── manager.ts    # Scan manager
│   │   └── providers/    # Tree view providers
│   └── utils/            # Utility functions
├── .github/
│   └── workflows/        # CI/CD workflows
├── test/                 # Test files
└── docs/                 # Documentation
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository** and create a feature branch
2. **Follow the existing code style** (enforced by ESLint and Prettier)
3. **Write tests** for new features
4. **Update documentation** as needed
5. **Submit a pull request** with a clear description

### Development Guidelines

- Use TypeScript for all new code
- Follow conventional commit messages (feat, fix, docs, etc.)
- Ensure all tests pass before submitting PR
- Add unit tests for new functionality
- Update README for user-facing changes

### Reporting Issues

When reporting issues, please include:
- VS Code version
- Extension version
- Project type (Foundry/Hardhat)
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages or logs

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with the VS Code Extension API
- Solidity parsing powered by regular expressions and AST analysis
- Inspired by tools like Foundry's `forge` and Hardhat's contract interaction utilities

## Links

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=0xshubhs.0xtools)
- [GitHub Repository](https://github.com/0xshubhs/0xtools)
- [Issue Tracker](https://github.com/0xshubhs/0xtools/issues)
- [Changelog](https://github.com/0xshubhs/0xtools/releases)

---

**Maintained by**: [0xshubhs](https://github.com/0xshubhs)  
**Version**: 0.3.0  
**Last Updated**: November 2025
