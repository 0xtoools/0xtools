/**
 * Gas Pricing Service - Multi-chain gas pricing via public RPCs
 *
 * Fetches current gas prices from public RPC endpoints across supported
 * EVM chains and estimates transaction costs in both native tokens and USD.
 *
 * Uses Node's built-in `https` module (no external HTTP dependencies).
 * Gas prices are cached for a configurable TTL to avoid excessive RPC calls.
 */

import * as https from 'https';
import * as http from 'http';
import { GasPrice } from '../types';

/** Configuration for a supported chain. */
interface ChainConfig {
  name: string;
  rpcUrl: string;
  nativeToken: string;
  /** Approximate native token price in USD. Updated via cache or manual override. */
  defaultEthPriceUsd: number;
}

/** Internal cache entry with TTL tracking. */
interface CacheEntry {
  gasPrice: GasPrice;
  expiresAt: number;
}

/** Default cache time-to-live in milliseconds (60 seconds). */
const DEFAULT_CACHE_TTL_MS = 60_000;

/** HTTP request timeout in milliseconds (5s — gas price RPCs are fast). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Keep-alive HTTP agents, reused across requests. */
const gasPricingHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const gasPricingHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });

export class GasPricingService {
  private readonly chains: Map<string, ChainConfig>;
  private readonly cache: Map<string, CacheEntry>;
  private readonly cacheTtlMs: number;

  /**
   * Create a new GasPricingService.
   *
   * @param cacheTtlMs - Cache time-to-live in milliseconds (default: 60 seconds)
   */
  constructor(cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.cacheTtlMs = cacheTtlMs;
    this.cache = new Map();

    this.chains = new Map<string, ChainConfig>([
      [
        'ethereum',
        {
          name: 'Ethereum Mainnet',
          rpcUrl: 'https://eth.llamarpc.com',
          nativeToken: 'ETH',
          defaultEthPriceUsd: 3000,
        },
      ],
      [
        'polygon',
        {
          name: 'Polygon PoS',
          rpcUrl: 'https://polygon-rpc.com',
          nativeToken: 'MATIC',
          defaultEthPriceUsd: 0.5,
        },
      ],
      [
        'arbitrum',
        {
          name: 'Arbitrum One',
          rpcUrl: 'https://arb1.arbitrum.io/rpc',
          nativeToken: 'ETH',
          defaultEthPriceUsd: 3000,
        },
      ],
      [
        'optimism',
        {
          name: 'Optimism',
          rpcUrl: 'https://mainnet.optimism.io',
          nativeToken: 'ETH',
          defaultEthPriceUsd: 3000,
        },
      ],
      [
        'base',
        {
          name: 'Base',
          rpcUrl: 'https://mainnet.base.org',
          nativeToken: 'ETH',
          defaultEthPriceUsd: 3000,
        },
      ],
    ]);
  }

  /**
   * Get the list of supported chain identifiers.
   *
   * @returns Array of chain name strings (e.g., ['ethereum', 'polygon', ...])
   */
  public getSupportedChains(): string[] {
    return Array.from(this.chains.keys());
  }

  /**
   * Fetch the current gas price for a given chain.
   *
   * Returns a cached value if available and not expired. Otherwise, makes
   * an eth_gasPrice JSON-RPC call to the chain's public RPC endpoint.
   *
   * @param chain - The chain identifier (e.g., 'ethereum', 'polygon')
   * @returns GasPrice object or null if the chain is unsupported or the RPC call fails
   */
  public async fetchGasPrice(chain: string): Promise<GasPrice | null> {
    const config = this.chains.get(chain);
    if (!config) {
      return null;
    }

    // Check cache
    const cached = this.cache.get(chain);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.gasPrice;
    }

    try {
      const response = await this.jsonRpcCall(config.rpcUrl, 'eth_gasPrice', []);

      if (!response || !response.result) {
        return null;
      }

      // Parse hex gas price (in wei) and convert to gwei
      const gasPriceWei = BigInt(response.result);
      const gasPriceGwei = Number(gasPriceWei) / 1e9;

      const gasPrice: GasPrice = {
        chain,
        gasPriceGwei: parseFloat(gasPriceGwei.toFixed(4)),
        ethPriceUsd: config.defaultEthPriceUsd,
        timestamp: Date.now(),
      };

      // Cache the result
      this.cache.set(chain, {
        gasPrice,
        expiresAt: Date.now() + this.cacheTtlMs,
      });

      return gasPrice;
    } catch (error) {
      console.error(`Failed to fetch gas price for ${chain}:`, error);
      return null;
    }
  }

  /**
   * Estimate the cost of a transaction in both native token and USD.
   *
   * Fetches the current gas price for the chain and computes the cost
   * based on the provided gas units.
   *
   * @param gasUnits - Number of gas units the transaction requires
   * @param chain - The chain identifier
   * @returns Object with costUsd and costEth, or null if pricing is unavailable
   */
  public async estimateCostUsd(
    gasUnits: number,
    chain: string
  ): Promise<{ costUsd: number; costEth: number } | null> {
    const gasPrice = await this.fetchGasPrice(chain);
    if (!gasPrice) {
      return null;
    }

    // Cost in native token: gasUnits * gasPriceGwei * 1e-9 (gwei to full token)
    const costEth = gasUnits * gasPrice.gasPriceGwei * 1e-9;

    // Cost in USD
    const costUsd = costEth * gasPrice.ethPriceUsd;

    return {
      costEth: parseFloat(costEth.toFixed(8)),
      costUsd: parseFloat(costUsd.toFixed(6)),
    };
  }

  /**
   * Update the cached ETH/native token price for a given chain.
   *
   * Since fetching real-time token prices requires external APIs (CoinGecko, etc.),
   * this method allows callers to inject an updated price manually or from
   * an external price feed.
   *
   * @param chain - The chain identifier
   * @param priceUsd - The native token price in USD
   */
  public setTokenPrice(chain: string, priceUsd: number): void {
    const config = this.chains.get(chain);
    if (config) {
      config.defaultEthPriceUsd = priceUsd;

      // Update cache if it exists
      const cached = this.cache.get(chain);
      if (cached) {
        cached.gasPrice.ethPriceUsd = priceUsd;
      }
    }
  }

  /**
   * Clear the gas price cache for all chains or a specific chain.
   *
   * @param chain - Optional chain identifier. If omitted, clears all caches.
   */
  public clearCache(chain?: string): void {
    if (chain) {
      this.cache.delete(chain);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Make a JSON-RPC call using Node's built-in https module.
   *
   * @param rpcUrl - The RPC endpoint URL
   * @param method - The JSON-RPC method name
   * @param params - The JSON-RPC params array
   * @returns Parsed JSON response or null on error
   */
  private jsonRpcCall(
    rpcUrl: string,
    method: string,
    params: unknown[]
  ): Promise<{ result?: string; error?: { code: number; message: string } } | null> {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: 1,
      });

      const url = new URL(rpcUrl);
      const isHttps = url.protocol === 'https:';
      const mod = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'keep-alive',
        },
        agent: isHttps ? gasPricingHttpsAgent : gasPricingHttpAgent,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = mod.request(options, (res) => {
        let data = '';

        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            console.error(`Invalid JSON response from ${rpcUrl}`);
            resolve(null);
          }
        });
      });

      req.on('error', (err: Error) => {
        console.error(`RPC request to ${rpcUrl} failed: ${err.message}`);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        console.error(`RPC request to ${rpcUrl} timed out`);
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }
}
