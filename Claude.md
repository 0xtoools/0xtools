# 0xTools

Solidity smart contract analysis tool — VS Code extension + CLI. Extracts function selectors, event topics, error selectors, and provides real-time gas estimation with inline decorations.

## Quick Start

```bash
pnpm install                    # Install deps
pnpm run compile                # Build (webpack, production)
cd runner && cargo build        # Build Rust runner (optional)
pnpm test                       # Run tests (jest)
npx tsc --noEmit                # Type-check only
```

## Architecture

```
User → Extension (VS Code) / CLI
         ↓
     Core Engine: scanner → parser → cache → exporter
         ↓
     Features: realtime → compilation-service → [Runner | Forge | Solc]
         ↓
     Analysis: gas, storage-layout, call-graph, deployment, complexity, size
```

**Three-tier compilation backend** (priority order):
1. **Runner** — Rust binary (`runner/src/`), deploys contracts in revm, executes functions for real gas
2. **Forge** — Shells out to `forge build` for Foundry projects
3. **Solc-JS** — WASM compiler, universal fallback

If all compilation fails, regex fallback still extracts selectors (gas shows N/A).

## Directory Map

| Path | What |
|------|------|
| `src/core/` | Scanner, parser, watcher, cache, exporter |
| `src/extension/` | VS Code activation, commands, tree view |
| `src/features/` | All analysis modules (gas, storage, complexity, etc.) |
| `src/cli/` | CLI entry point |
| `src/utils/` | keccak256, helpers |
| `src/types.ts` | Shared TypeScript interfaces |
| `runner/src/` | Rust backend (revm-based EVM execution) |
| `examples/` | 8 sample projects (Foundry + Hardhat) |

## Key Files

| File | Role |
|------|------|
| `realtime.ts` | Main analysis orchestrator (1,385 LOC) |
| `compilation-service.ts` | Debounced compilation with caching |
| `SolcManager.ts` | Solc-js lifecycle, pragma resolution |
| `runner-backend.ts` | Spawns Rust binary, parses JSON |
| `forge-backend.ts` | Forge build integration |
| `parser.ts` | Regex-based Solidity parsing |
| `gas-decorations.ts` | Inline VS Code decorations |
| `evm.rs` | Deploy + execute contracts in revm |
| `calldata.rs` | Smart argument generation (3 strategies) |

## Rust Runner

Located at `runner/src/`. Uses revm to deploy contracts and execute every public/external function.

- **Strategies**: SmartDefaults → CallerAddress → ZeroDefaults (early-exit on success)
- **CALLER**: `0x1000...0001`, funded 10k ETH
- **Output**: JSON array of `ContractReport { contract, functions: [FunctionReport] }`
- **Build**: `cd runner && cargo build` (binary at `runner/target/debug/sigscan-runner`)

## Configuration (VS Code)

Key settings in `sigscan.*`:
- `preferRunner` (bool, default: true) — Use Rust runner as primary backend
- `realtimeAnalysis` (bool) — Live inline gas annotations
- `realtime.solcIdleMs` (number, 10000) — Delay before solc kicks in
- `gas.solcOnly` (bool, true) — No heuristic fallback

## Patterns to Follow

- Content-hash caching (SHA-256) with 5min TTL — don't bypass
- Debounce compilation (300ms) — prevents spam during typing
- Regex fallback when compilation fails — selectors must always be available
- Extended analysis is lazy-loaded and resource-gated (CPU <50%, Mem <500MB)
- Runner output is pure JSON, no side effects

## Dependencies (production)

Only 6: `chokidar`, `commander`, `glob`, `js-sha3`, `semver`, `solc`

No ethers.js, no web3.js, no axios. Keep it minimal.
