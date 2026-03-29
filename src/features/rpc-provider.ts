/**
 * Multi-chain RPC Provider — Foundation layer for on-chain interactions.
 *
 * Provides configurable RPC endpoints per chain, JSON-RPC method calls,
 * convenience wrappers for common Ethereum methods, and basic error handling
 * with timeouts.
 *
 * Uses Node's built-in `https`/`http` modules (no external HTTP dependencies).
 */

import * as https from 'https';
import * as http from 'http';

/** Configuration for a supported EVM chain. */
export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl?: string;
  currency: string;
  decimals: number;
}

/** HTTP request timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000;

/** TTL constants for response caching (milliseconds). */
const TTL_BALANCE = 30_000; // 30s for balances (change frequently)
const TTL_CODE = 5 * 60_000; // 5min for code (rarely changes)
const TTL_TX_RECEIPT = Infinity; // permanent for tx receipts (immutable)
const TTL_TX = Infinity; // permanent for mined txs (immutable)
const TTL_BLOCK = 60_000; // 1min for blocks
const TTL_NONCE = 30_000; // 30s for nonces

/** Cached response entry with TTL. */
interface CachedEntry<T = any> {
  value: T;
  expires: number;
}

/** Keep-alive HTTP agents, reused across requests. */
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 6 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 6 });

/** Built-in default chain configurations. */
export const DEFAULT_CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    currency: 'ETH',
    decimals: 18,
  },
  sepolia: {
    chainId: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://rpc.sepolia.org',
    explorerUrl: 'https://sepolia.etherscan.io',
    currency: 'ETH',
    decimals: 18,
  },
  polygon: {
    chainId: 137,
    name: 'Polygon',
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    currency: 'MATIC',
    decimals: 18,
  },
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    currency: 'ETH',
    decimals: 18,
  },
  optimism: {
    chainId: 10,
    name: 'Optimism',
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    currency: 'ETH',
    decimals: 18,
  },
  bsc: {
    chainId: 56,
    name: 'BNB Smart Chain',
    rpcUrl: 'https://bsc-dataseed1.binance.org',
    explorerUrl: 'https://bscscan.com',
    currency: 'BNB',
    decimals: 18,
  },
  base: {
    chainId: 8453,
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    currency: 'ETH',
    decimals: 18,
  },
  avalanche: {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowtrace.io',
    currency: 'AVAX',
    decimals: 18,
  },
};

export class RpcProvider {
  private chains: Map<string, ChainConfig>;
  private customEndpoints: Map<string, string>;
  private requestId: number;
  private cache: Map<string, CachedEntry>;
  private inflight: Map<string, Promise<any>>;
  private readonly MAX_CACHE_SIZE = 500;

  constructor() {
    this.chains = new Map();
    this.customEndpoints = new Map();
    this.requestId = 1;
    this.cache = new Map();
    this.inflight = new Map();

    // Load default chains
    for (const [name, config] of Object.entries(DEFAULT_CHAINS)) {
      this.chains.set(name, { ...config });
    }
  }

  /** Store a value in the cache with bounded LRU-style eviction. */
  private cacheSet(key: string, value: any, ttlMs: number): void {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      // Evict oldest entry (first inserted key — Map preserves insertion order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { value, expires: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
  }

  /** Get a cached value or fetch it, storing with the given TTL. */
  private async getCached<T>(key: string, ttlMs: number, fetch: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && (cached.expires === Infinity || Date.now() < cached.expires)) {
      return cached.value as T;
    }
    const value = await fetch();
    this.cacheSet(key, value, ttlMs);
    return value;
  }

  /** Clear the entire response cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Add or override a chain's RPC endpoint. */
  setEndpoint(chainName: string, rpcUrl: string): void {
    this.customEndpoints.set(chainName, rpcUrl);
  }

  /** Add a custom chain. */
  addChain(name: string, config: ChainConfig): void {
    this.chains.set(name, { ...config });
  }

  /** Get all available chain names. */
  getChains(): string[] {
    return Array.from(this.chains.keys());
  }

  /** Get chain config by name. */
  getChain(name: string): ChainConfig | undefined {
    return this.chains.get(name);
  }

  /** Resolve the RPC URL for a chain (custom endpoint takes priority). */
  private getRpcUrl(chain: string): string {
    const custom = this.customEndpoints.get(chain);
    if (custom) {
      return custom;
    }
    const config = this.chains.get(chain);
    if (!config) {
      throw new Error(`Unknown chain: "${chain}". Available: ${this.getChains().join(', ')}`);
    }
    return config.rpcUrl;
  }

  /** Raw JSON-RPC call with in-flight request deduplication. */
  async call(chain: string, method: string, params: any[]): Promise<any> {
    const dedupeKey = `${chain}:${method}:${JSON.stringify(params)}`;

    // Deduplicate in-flight requests: return existing promise if same call is pending
    const existing = this.inflight.get(dedupeKey);
    if (existing) {
      return existing;
    }

    const promise = this._doCall(chain, method, params).finally(() => {
      this.inflight.delete(dedupeKey);
    });
    this.inflight.set(dedupeKey, promise);
    return promise;
  }

  /** Internal: execute a single JSON-RPC call. */
  private async _doCall(chain: string, method: string, params: any[]): Promise<any> {
    const rpcUrl = this.getRpcUrl(chain);
    const id = this.requestId++;
    const body = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    const response = await this.httpPost(rpcUrl, body);

    if (!response) {
      throw new Error(`No response from ${chain} RPC (${method})`);
    }

    if (response.error) {
      throw new Error(
        `RPC error on ${chain} ${method}: [${response.error.code}] ${response.error.message}`
      );
    }

    return response.result;
  }

  /**
   * Batch JSON-RPC call — send multiple method calls in a single HTTP request.
   *
   * Many RPC providers support JSON-RPC batch requests (an array of request
   * objects). This reduces round-trips when you need multiple independent calls.
   *
   * @param chain - The chain to call
   * @param calls - Array of { method, params } objects
   * @returns Array of results in the same order as `calls`
   */
  async batchCall(chain: string, calls: Array<{ method: string; params: any[] }>): Promise<any[]> {
    if (calls.length === 0) {
      return [];
    }
    // Single call — no need to batch
    if (calls.length === 1) {
      const result = await this.call(chain, calls[0].method, calls[0].params);
      return [result];
    }

    const rpcUrl = this.getRpcUrl(chain);
    const batchBody = calls.map((c) => ({
      jsonrpc: '2.0' as const,
      method: c.method,
      params: c.params,
      id: this.requestId++,
    }));

    const response = await this.httpPost(rpcUrl, batchBody);

    if (!response) {
      throw new Error(`No response from ${chain} batch RPC`);
    }

    // Batch response is an array; order may differ — index by id
    if (!Array.isArray(response)) {
      // Some RPCs don't support batch; fall back to sequential calls
      const results: any[] = [];
      for (const c of calls) {
        results.push(await this.call(chain, c.method, c.params));
      }
      return results;
    }

    const byId = new Map<number, any>();
    for (const r of response as any[]) {
      byId.set(r.id, r);
    }

    return batchBody.map((req) => {
      const r = byId.get(req.id);
      if (!r) {
        throw new Error(`Missing response for batch request id ${req.id}`);
      }
      if (r.error) {
        throw new Error(
          `RPC error on ${chain} ${req.method}: [${r.error.code}] ${r.error.message}`
        );
      }
      return r.result;
    });
  }

  /** Convenience: eth_getBalance — returns balance as bigint (wei). */
  async getBalance(chain: string, address: string, block = 'latest'): Promise<bigint> {
    const cacheKey = `bal:${chain}:${address}:${block}`;
    return this.getCached(cacheKey, TTL_BALANCE, async () => {
      const result = await this.call(chain, 'eth_getBalance', [address, block]);
      return BigInt(result);
    });
  }

  /** Convenience: eth_getCode — returns bytecode hex string. */
  async getCode(chain: string, address: string): Promise<string> {
    const cacheKey = `code:${chain}:${address}`;
    return this.getCached(cacheKey, TTL_CODE, () =>
      this.call(chain, 'eth_getCode', [address, 'latest'])
    );
  }

  /** Convenience: eth_getTransactionCount — returns nonce as number. */
  async getTransactionCount(chain: string, address: string): Promise<number> {
    const cacheKey = `nonce:${chain}:${address}`;
    return this.getCached(cacheKey, TTL_NONCE, async () => {
      const result = await this.call(chain, 'eth_getTransactionCount', [address, 'latest']);
      return Number(BigInt(result));
    });
  }

  /** Convenience: eth_getTransactionByHash. */
  async getTransaction(chain: string, txHash: string): Promise<any> {
    const cacheKey = `tx:${chain}:${txHash}`;
    return this.getCached(cacheKey, TTL_TX, () =>
      this.call(chain, 'eth_getTransactionByHash', [txHash])
    );
  }

  /** Convenience: eth_getTransactionReceipt. */
  async getTransactionReceipt(chain: string, txHash: string): Promise<any> {
    const cacheKey = `receipt:${chain}:${txHash}`;
    return this.getCached(cacheKey, TTL_TX_RECEIPT, () =>
      this.call(chain, 'eth_getTransactionReceipt', [txHash])
    );
  }

  /** Convenience: eth_getBlockByNumber. */
  async getBlock(chain: string, blockNumber: string | number): Promise<any> {
    const blockParam =
      typeof blockNumber === 'number' ? '0x' + blockNumber.toString(16) : blockNumber;
    // Only cache numeric blocks (not 'latest')
    const ttl = typeof blockNumber === 'number' ? TTL_TX : TTL_BLOCK;
    const cacheKey = `block:${chain}:${blockParam}`;
    return this.getCached(cacheKey, ttl, () =>
      this.call(chain, 'eth_getBlockByNumber', [blockParam, false])
    );
  }

  /** Convenience: eth_call (simulate without sending). */
  async ethCall(chain: string, to: string, data: string, block = 'latest'): Promise<string> {
    return await this.call(chain, 'eth_call', [{ to, data }, block]);
  }

  /** Convenience: eth_getLogs. */
  async getLogs(
    chain: string,
    filter: { address?: string; topics?: (string | null)[]; fromBlock?: string; toBlock?: string }
  ): Promise<any[]> {
    const params: any = {};
    if (filter.address) {
      params.address = filter.address;
    }
    if (filter.topics) {
      params.topics = filter.topics;
    }
    params.fromBlock = filter.fromBlock || 'latest';
    params.toBlock = filter.toBlock || 'latest';

    return await this.call(chain, 'eth_getLogs', [params]);
  }

  /** Convenience: eth_getStorageAt. */
  async getStorageAt(
    chain: string,
    address: string,
    slot: string,
    block = 'latest'
  ): Promise<string> {
    return await this.call(chain, 'eth_getStorageAt', [address, slot, block]);
  }

  /** Convenience: eth_chainId — returns chain ID as number. */
  async getChainId(chain: string): Promise<number> {
    const result = await this.call(chain, 'eth_chainId', []);
    return Number(BigInt(result));
  }

  /** Convenience: eth_blockNumber — returns block number as number. */
  async getBlockNumber(chain: string): Promise<number> {
    const result = await this.call(chain, 'eth_blockNumber', []);
    return Number(BigInt(result));
  }

  /**
   * Format wei to human-readable string (e.g., "1.5 ETH").
   *
   * Handles up to 18 decimal places and trims trailing zeros.
   */
  formatValue(wei: bigint, chain: string): string {
    const config = this.chains.get(chain);
    const currency = config?.currency || 'ETH';
    const decimals = config?.decimals || 18;

    if (wei === 0n) {
      return `0 ${currency}`;
    }

    const divisor = 10n ** BigInt(decimals);
    const wholePart = wei / divisor;
    const fracPart = wei % divisor;

    if (fracPart === 0n) {
      return `${wholePart.toString()} ${currency}`;
    }

    // Pad fractional part to full decimal width, then trim trailing zeros
    let fracStr = fracPart.toString().padStart(decimals, '0');
    fracStr = fracStr.replace(/0+$/, '');

    // Limit to 8 significant decimal digits for readability
    if (fracStr.length > 8) {
      fracStr = fracStr.substring(0, 8);
    }

    return `${wholePart.toString()}.${fracStr} ${currency}`;
  }

  /**
   * Perform an HTTP POST request using Node's built-in https/http module.
   * Accepts a single JSON-RPC request object or an array for batch requests.
   */
  private httpPost(url: string, body: object | object[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const mod = isHttps ? https : http;
      const data = JSON.stringify(body);

      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Connection: 'keep-alive',
        },
        agent: isHttps ? httpsAgent : httpAgent,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = mod.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk: Buffer | string) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseBody);
            resolve(parsed);
          } catch {
            reject(
              new Error(`Invalid JSON response from ${url}: ${responseBody.substring(0, 200)}`)
            );
          }
        });
      });

      req.on('error', (err: Error) => {
        reject(new Error(`RPC request to ${url} failed: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`RPC request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      });

      req.write(data);
      req.end();
    });
  }
}
