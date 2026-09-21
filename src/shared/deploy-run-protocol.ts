// Wire protocol between the Deploy & Run webview and the extension host.
// Imported by both sides — keep dependency-free.

import type { AbiEntry } from '../features/remix-port/tx-helper';
export type { AbiEntry, AbiParameter } from '../features/remix-port/tx-helper';

// Mirrors Remix's environment hardfork choices. Newer first to match Remix's UI order.
// Each value is a valid anvil --hardfork name. Anvil also accepts `merge` as an alias for paris.
export type HardforkName =
  'osaka' | 'prague' | 'cancun' | 'shanghai' | 'paris' | 'london' | 'berlin';

export const ALL_HARDFORKS: ReadonlyArray<HardforkName> = [
  'osaka',
  'prague',
  'cancun',
  'shanghai',
  'paris',
  'london',
  'berlin',
];

/** Notable opcode/feature deltas — surfaced as tooltips in the panel. */
export const HARDFORK_NOTES: Record<HardforkName, string> = {
  osaka: 'next planned envelope (post-Prague)',
  prague: 'EIP-7702 set-code, EIP-2537 BLS precompiles',
  cancun: 'EIP-1153 TLOAD/TSTORE, EIP-5656 MCOPY, EIP-4844 blob tx, EIP-7516 BLOBBASEFEE',
  shanghai: 'EIP-3855 PUSH0, withdrawals',
  paris: 'the Merge — PoS transition; PREVRANDAO',
  london: 'EIP-1559 fee market, EIP-3198 BASEFEE',
  berlin: 'EIP-2929 access lists',
};

export type LogLevel = 'info' | 'warn' | 'error';

export type ValueUnit = 'wei' | 'gwei' | 'ether';

export type NetworkKind =
  | 'anvil'
  | 'ethereum'
  | 'sepolia'
  | 'base'
  | 'base-sepolia'
  | 'arbitrum'
  | 'arbitrum-sepolia'
  | 'optimism'
  | 'optimism-sepolia'
  | 'polygon'
  | 'polygon-amoy'
  | 'bsc'
  | 'bsc-testnet'
  | 'custom';

export interface NetworkConfig {
  kind: NetworkKind;
  name: string;
  /** Primary RPC URL (first one tried). */
  rpcUrl?: string;
  /** Fallback RPC URLs — tried in order if the primary fails or times out. */
  rpcUrls?: string[];
  chainId?: number;
  explorerUrl?: string;
  /** Native token symbol — ETH, MATIC, BNB, etc. Used for balance display. */
  nativeSymbol?: string;
  isTestnet?: boolean;
}

// Curated subset of chainlist.org — popular EVM chains with multiple public RPC
// fallbacks. The provider tries them in order on each balance/tx call.
export const BUILT_IN_NETWORKS: readonly NetworkConfig[] = [
  {
    kind: 'anvil',
    name: 'Anvil (local)',
    nativeSymbol: 'ETH',
  },
  // ─── Mainnets ─────────────────────────────────────────────────────────
  {
    kind: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://etherscan.io',
    rpcUrl: 'https://eth.llamarpc.com',
    rpcUrls: [
      'https://ethereum.publicnode.com',
      'https://rpc.ankr.com/eth',
      'https://cloudflare-eth.com',
    ],
  },
  {
    kind: 'base',
    name: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://basescan.org',
    rpcUrl: 'https://mainnet.base.org',
    rpcUrls: [
      'https://base.llamarpc.com',
      'https://base.publicnode.com',
      'https://base-rpc.publicnode.com',
    ],
  },
  {
    kind: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://arbiscan.io',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    rpcUrls: ['https://arbitrum.llamarpc.com', 'https://arbitrum.publicnode.com'],
  },
  {
    kind: 'optimism',
    name: 'Optimism',
    chainId: 10,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    rpcUrl: 'https://mainnet.optimism.io',
    rpcUrls: ['https://optimism.llamarpc.com', 'https://optimism.publicnode.com'],
  },
  {
    kind: 'polygon',
    name: 'Polygon',
    chainId: 137,
    nativeSymbol: 'POL',
    explorerUrl: 'https://polygonscan.com',
    rpcUrl: 'https://polygon-rpc.com',
    rpcUrls: ['https://polygon.llamarpc.com', 'https://polygon.publicnode.com'],
  },
  {
    kind: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    nativeSymbol: 'BNB',
    explorerUrl: 'https://bscscan.com',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    rpcUrls: ['https://bsc.publicnode.com', 'https://bsc-rpc.publicnode.com'],
  },
  // ─── Testnets ─────────────────────────────────────────────────────────
  {
    kind: 'sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://sepolia.etherscan.io',
    isTestnet: true,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    rpcUrls: [
      'https://rpc.sepolia.org',
      'https://ethereum-sepolia.blockpi.network/v1/rpc/public',
      'https://sepolia.gateway.tenderly.co',
    ],
  },
  {
    kind: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: 84532,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://sepolia.basescan.org',
    isTestnet: true,
    rpcUrl: 'https://sepolia.base.org',
    rpcUrls: [
      'https://base-sepolia-rpc.publicnode.com',
      'https://base-sepolia.blockpi.network/v1/rpc/public',
    ],
  },
  {
    kind: 'arbitrum-sepolia',
    name: 'Arbitrum Sepolia',
    chainId: 421614,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://sepolia.arbiscan.io',
    isTestnet: true,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    rpcUrls: [
      'https://arbitrum-sepolia.publicnode.com',
      'https://arbitrum-sepolia.blockpi.network/v1/rpc/public',
    ],
  },
  {
    kind: 'optimism-sepolia',
    name: 'Optimism Sepolia',
    chainId: 11155420,
    nativeSymbol: 'ETH',
    explorerUrl: 'https://sepolia-optimism.etherscan.io',
    isTestnet: true,
    rpcUrl: 'https://sepolia.optimism.io',
    rpcUrls: ['https://optimism-sepolia.publicnode.com'],
  },
  {
    kind: 'polygon-amoy',
    name: 'Polygon Amoy',
    chainId: 80002,
    nativeSymbol: 'POL',
    explorerUrl: 'https://amoy.polygonscan.com',
    isTestnet: true,
    rpcUrl: 'https://rpc-amoy.polygon.technology',
    rpcUrls: [
      'https://polygon-amoy.blockpi.network/v1/rpc/public',
      'https://polygon-amoy.publicnode.com',
    ],
  },
  {
    kind: 'bsc-testnet',
    name: 'BSC Testnet',
    chainId: 97,
    nativeSymbol: 'tBNB',
    explorerUrl: 'https://testnet.bscscan.com',
    isTestnet: true,
    rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    rpcUrls: ['https://bsc-testnet.publicnode.com'],
  },
];

/** Resolve a chain by its kind. */
export function networkByKind(kind: NetworkKind): NetworkConfig | undefined {
  return BUILT_IN_NETWORKS.find((n) => n.kind === kind);
}

/** Group networks for a sectioned dropdown: Local / Mainnets / Testnets. */
export interface NetworkGroup {
  label: string;
  networks: NetworkConfig[];
}

export function groupedNetworks(): NetworkGroup[] {
  return [
    { label: 'Local', networks: BUILT_IN_NETWORKS.filter((n) => n.kind === 'anvil') },
    {
      label: 'Mainnets',
      networks: BUILT_IN_NETWORKS.filter((n) => n.kind !== 'anvil' && !n.isTestnet),
    },
    {
      label: 'Testnets',
      networks: BUILT_IN_NETWORKS.filter((n) => n.isTestnet),
    },
  ];
}

export type AccountSelection =
  | { kind: 'anvil'; index: number; address: string }
  | { kind: 'keystore'; name: string; address: string }
  | { kind: 'none' };

export interface AnvilStatus {
  available: boolean;
  running: boolean;
  port?: number;
  rpcUrl?: string;
  chainId?: number;
  hardfork?: HardforkName;
  accounts: Array<{ address: string; balance: string }>;
}

export interface KeystoreBalance {
  /** Wei amount as a decimal string (avoid bigint over the wire). */
  wei: string;
  /** Human-friendly amount, e.g. "0.1234". */
  formatted: string;
  /** Native token symbol — ETH, POL, BNB. */
  symbol: string;
  /** The chain this balance was read from. */
  chainId: number;
  /** Wall-clock ms when the balance was fetched. */
  fetchedAt: number;
}

export type BalanceStatus = 'idle' | 'fetching' | 'ok' | 'error';

export interface KeystoreInfo {
  name: string;
  address: string;
  /** Populated for the *currently active* network (anvil mode keeps using anvil's account list). */
  balance?: KeystoreBalance;
  balanceStatus?: BalanceStatus;
  balanceError?: string;
}

export type ContractBuildState = 'not-built' | 'building' | 'built' | 'failed';

export interface ContractSummary {
  key: string;
  name: string;
  file: string;
  sourcePath: string;
  projectRoot: string;
  projectType: 'foundry' | 'hardhat' | 'solidity';
  abi: AbiEntry[]; // empty array if not built yet
  hasBytecode: boolean;
  buildState: ContractBuildState;
  lastError?: string;
}

export interface ProjectGroup {
  projectRoot: string;
  projectType: 'foundry' | 'hardhat' | 'solidity';
  /**
   * Files grouped by directory under projectRoot for tree-style display.
   * Each directory bucket contains both contracts (.sol) and scripts
   * (.s.sol / .ts / .js) so the panel can render them inline next to
   * each other — the way they actually live on disk.
   */
  byDirectory: Array<{
    dir: string;
    contracts: ContractSummary[];
    scripts: ScriptSummary[];
  }>;
  built: number;
  total: number;
  isBuilding: boolean;
}

export type ScriptKind = 'foundry' | 'hardhat-ts' | 'hardhat-js';
export type ScriptRunState = 'idle' | 'running' | 'success' | 'error';

export interface ScriptSummary {
  key: string;
  name: string;
  relPath: string;
  projectRoot: string;
  projectType: 'foundry' | 'hardhat' | 'solidity';
  kind: ScriptKind;
  runState: ScriptRunState;
  /** Last error message — present when runState === 'error'. */
  lastError?: string;
  /** Last run's deployed contract addresses, parsed from output. */
  lastDeployed?: string[];
  /** Last run's transaction hashes, parsed from output. */
  lastTxHashes?: string[];
  lastDurationMs?: number;
}

export type VerifyStatus = 'idle' | 'verifying' | 'verified' | 'already-verified' | 'failed';

export interface DeployedInstance {
  id: string; // local UUID
  name: string;
  address: string;
  network: NetworkKind;
  abi: AbiEntry[];
  deployedAt: number; // epoch ms
  fromKey?: string; // ContractSummary.key if known
  /** Chain id at deploy time — pinned so persisted entries survive network renames. */
  chainId?: number;
  /** Deployment tx hash, when we have one (loadAtAddress entries don't). */
  txHash?: string;
  /** Hex-encoded constructor arg bytes (without 0x prefix) — needed by `forge verify-contract`. */
  ctorArgsEncoded?: string;
  /** Absolute path to the contract source file. Required for verification. */
  sourcePath?: string;
  projectRoot?: string;
  projectType?: 'foundry' | 'hardhat' | 'solidity';
  verifyStatus?: VerifyStatus;
  verifyError?: string;
  /** Explorer URL to the verified source, when verification succeeded. */
  verifyUrl?: string;
}

export interface TxLogEntry {
  id: string;
  kind: 'deploy' | 'send' | 'call';
  contractName: string;
  funcName?: string;
  status: 'pending' | 'success' | 'reverted' | 'error';
  txHash?: string;
  gasUsed?: string;
  blockNumber?: number;
  errorMessage?: string;
  decodedEvents?: Array<{ name: string; args: Record<string, unknown> }>;
  returnValue?: unknown;
  /** Address of the newly deployed contract (deploy entries only). */
  deployedAddress?: string;
  /** Sender / from-address — present for all entries we sign. */
  fromAddress?: string;
  /** Target contract address (send/call entries). */
  toAddress?: string;
  /** Value carried by the transaction, as a decimal-string wei amount. */
  valueWei?: string;
  /** Network identifier the tx ran on — anvil chain id, sepolia, etc. */
  networkLabel?: string;
  /** Chain id at tx time. Set when known so the webview can compose explorer URLs. */
  chainId?: number;
  at: number; // epoch ms
}

export interface DeployRunStatus {
  anvil: AnvilStatus;
  selectedHardfork: HardforkName;
  network: NetworkConfig;
  account: AccountSelection;
  contracts: ContractSummary[];
  projectGroups: ProjectGroup[];
  instances: DeployedInstance[];
  keystores: KeystoreInfo[];
  txLog: TxLogEntry[];
  /** Build commands currently running, keyed by projectRoot. */
  buildingProjects: string[];
  /** Discovered deploy scripts (forge .s.sol + hardhat scripts/). */
  scripts: ScriptSummary[];
}

// ─── Requests ────────────────────────────────────────────────────────────

export type DeployRunRequest =
  | { kind: 'getStatus' }
  | { kind: 'startAnvil'; hardfork?: HardforkName; port?: number; forkUrl?: string }
  | { kind: 'stopAnvil' }
  | { kind: 'restartAnvil'; hardfork?: HardforkName }
  | { kind: 'refreshContracts' }
  | { kind: 'buildProject'; projectRoot: string }
  | { kind: 'buildAll' }
  | { kind: 'refreshBalance' }
  | { kind: 'refreshAllBalances' }
  | { kind: 'refreshScripts' }
  | { kind: 'runScript'; scriptKey: string; hardhatNetwork?: string }
  | { kind: 'selectNetwork'; network: NetworkConfig }
  | { kind: 'selectAccount'; selection: AccountSelection }
  | { kind: 'refreshKeystores' }
  | {
      kind: 'deployContract';
      contractKey: string;
      // Raw strings from the form: length === N for per-field mode,
      // length === 1 for inline comma-separated mode (parsed via parseFunctionParams host-side).
      ctorArgsRaw: string[];
      valueWei?: string; // bigint as string
      gasLimit?: string; // bigint as string
    }
  | {
      kind: 'callFunction';
      address: string;
      abi: AbiEntry[];
      funcName: string;
      argsRaw: string[];
      valueWei?: string;
    }
  | {
      kind: 'sendTransaction';
      address: string;
      abi: AbiEntry[];
      funcName: string;
      argsRaw: string[];
      valueWei?: string;
      gasLimit?: string;
    }
  | { kind: 'loadAtAddress'; contractKey: string; address: string }
  | { kind: 'removeInstance'; instanceId: string }
  | { kind: 'clearAllInstances' }
  | { kind: 'openExplorer'; url: string }
  | { kind: 'verifyInstance'; instanceId: string }
  | { kind: 'clearTxLog' };

// ─── Responses ───────────────────────────────────────────────────────────

export type DeployRunResponse =
  | { kind: 'status'; payload: DeployRunStatus }
  | { kind: 'ok' }
  | { kind: 'deployResult'; payload: { instance: DeployedInstance; txEntry: TxLogEntry } }
  | { kind: 'callResult'; payload: { decoded: unknown; txEntry: TxLogEntry } }
  | { kind: 'sendResult'; payload: { txEntry: TxLogEntry } }
  | { kind: 'error'; message: string };

// ─── Events (host → webview, fire-and-forget) ────────────────────────────

export type DeployRunEvent =
  | { kind: 'statusChanged'; payload: DeployRunStatus }
  | { kind: 'txAppended'; payload: TxLogEntry }
  | { kind: 'log'; level: LogLevel; message: string }
  | { kind: 'buildStarted'; projectRoot: string; command: string }
  | { kind: 'buildLog'; projectRoot: string; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'buildFinished'; projectRoot: string; ok: boolean; durationMs: number; error?: string }
  | { kind: 'scriptStarted'; scriptKey: string }
  | { kind: 'scriptLog'; scriptKey: string; stream: 'stdout' | 'stderr'; line: string }
  | {
      kind: 'scriptFinished';
      scriptKey: string;
      ok: boolean;
      durationMs: number;
      error?: string;
      deployed: string[];
      txHashes: string[];
    }
  | { kind: 'verifyStarted'; instanceId: string }
  | { kind: 'verifyLog'; instanceId: string; stream: 'stdout' | 'stderr'; line: string }
  | {
      kind: 'verifyFinished';
      instanceId: string;
      ok: boolean;
      status: VerifyStatus;
      error?: string;
      explorerUrl?: string;
    };

// ─── Envelopes ───────────────────────────────────────────────────────────

export interface RequestEnvelope {
  type: 'req';
  id: string;
  req: DeployRunRequest;
}

export interface ResponseEnvelope {
  type: 'res';
  id: string;
  res: DeployRunResponse;
}

export interface EventEnvelope {
  type: 'evt';
  evt: DeployRunEvent;
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

export function isRequest(e: Envelope): e is RequestEnvelope {
  return e.type === 'req';
}
export function isResponse(e: Envelope): e is ResponseEnvelope {
  return e.type === 'res';
}
export function isEvent(e: Envelope): e is EventEnvelope {
  return e.type === 'evt';
}

// ─── Unit conversion helpers (used on both sides) ────────────────────────

export function valueToWei(value: string, unit: ValueUnit): bigint {
  if (!value || value.trim() === '') {
    return 0n;
  }
  const trimmed = value.trim();
  const isNegative = trimmed.startsWith('-');
  const unsigned = isNegative ? trimmed.slice(1) : trimmed;
  const parts = unsigned.split('.');
  if (parts.length > 2) {
    throw new Error(`invalid numeric value: ${value}`);
  }
  const intPart = parts[0];
  const fracPart = parts[1] ?? '';
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new Error(`invalid numeric value: ${value}`);
  }
  const multipliers: Record<ValueUnit, number> = { wei: 0, gwei: 9, ether: 18 };
  const decimals = multipliers[unit];
  // Right-pad/truncate the fractional segment to exactly `decimals` chars
  const truncatedFrac =
    fracPart.length > decimals ? fracPart.slice(0, decimals) : fracPart.padEnd(decimals, '0');
  const combined = intPart + truncatedFrac;
  const cleaned = combined.replace(/^0+/, '') || '0';
  return (isNegative ? -1n : 1n) * BigInt(cleaned);
}

// ─── Block-explorer URL helpers ──────────────────────────────────────────

export type ExplorerLinkKind = 'tx' | 'address';

/**
 * Compose a block-explorer URL for a tx hash or address. Returns null when the
 * network has no `explorerUrl` (anvil, custom chains without one).
 *
 * Etherscan-family, blockscout, basescan, etc. all use the same /tx/<hash> and
 * /address/<addr> path convention, so a single composer works for the chains
 * we ship in BUILT_IN_NETWORKS.
 */
export function buildExplorerUrl(
  explorerUrl: string | undefined,
  kind: ExplorerLinkKind,
  value: string
): string | null {
  if (!explorerUrl) {
    return null;
  }
  if (!value) {
    return null;
  }
  const base = explorerUrl.replace(/\/+$/, '');
  return `${base}/${kind}/${value}`;
}

/** Look up the explorer URL for a given chain by NetworkKind. */
export function explorerUrlForKind(kind: NetworkKind): string | undefined {
  return BUILT_IN_NETWORKS.find((n) => n.kind === kind)?.explorerUrl;
}

/** Look up the explorer URL for a chain by its numeric chainId. */
export function explorerUrlForChainId(chainId: number | undefined): string | undefined {
  if (chainId === undefined) {
    return undefined;
  }
  return BUILT_IN_NETWORKS.find((n) => n.chainId === chainId)?.explorerUrl;
}
