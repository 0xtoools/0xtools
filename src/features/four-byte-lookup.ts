/**
 * 4byte Directory Lookup - Query the 4byte.directory API for function signature resolution
 *
 * The 4byte.directory (https://www.4byte.directory) is a public database mapping
 * 4-byte function selectors to their text signatures. This module provides lookup
 * capabilities for resolving unknown selectors encountered in transaction calldata
 * or contract analysis.
 *
 * Uses Node's built-in `https` module with no external HTTP dependencies.
 */

import * as https from 'https';

/** Base URL for the 4byte.directory API. */
const FOUR_BYTE_API_BASE = 'https://www.4byte.directory/api/v1/signatures/';

/** HTTP request timeout in milliseconds (5s — simple API lookups). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Maximum number of concurrent requests for batch lookups. */
const MAX_CONCURRENT_REQUESTS = 5;

/** Keep-alive HTTPS agent for 4byte API requests. */
const fourByteAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

/** Simple in-memory cache for lookup results. */
interface CacheEntry {
  signatures: string[];
  expiresAt: number;
}

/** Cache TTL: 10 minutes. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Maximum number of entries held in the lookup cache. */
const CACHE_MAX_SIZE = 1000;

export class FourByteLookup {
  private readonly cache: Map<string, CacheEntry>;
  private readonly inflight: Map<string, Promise<string[]>>;

  constructor() {
    this.cache = new Map();
    this.inflight = new Map();
  }

  /**
   * Look up a single 4-byte selector in the 4byte.directory.
   *
   * Returns an array of matching text signatures. Multiple signatures can
   * match the same selector due to hash collisions (e.g., both
   * "transfer(address,uint256)" and some other signature could produce
   * the same 4-byte prefix).
   *
   * @param selector - The 4-byte hex selector (e.g., "0xa9059cbb")
   * @returns Array of matching text signatures, or empty array on error
   */
  public async lookup(selector: string): Promise<string[]> {
    const normalizedSelector = this.normalizeSelector(selector);
    if (!normalizedSelector) {
      return [];
    }

    // Check cache
    const cached = this.cache.get(normalizedSelector);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.signatures;
    }

    // Deduplicate in-flight requests for the same selector
    const existing = this.inflight.get(normalizedSelector);
    if (existing) {
      return existing;
    }

    const promise = this._doLookup(normalizedSelector).finally(() => {
      this.inflight.delete(normalizedSelector);
    });
    this.inflight.set(normalizedSelector, promise);
    return promise;
  }

  /** Internal: perform the actual HTTP lookup for a single selector. */
  private async _doLookup(normalizedSelector: string): Promise<string[]> {
    try {
      const url = `${FOUR_BYTE_API_BASE}?hex_signature=${normalizedSelector}`;
      const response = await this.httpGet(url);

      if (!response) {
        return [];
      }

      const parsed = JSON.parse(response);
      const signatures = this.extractSignatures(parsed);

      // Cache the result — evict oldest entry when at capacity
      if (this.cache.size >= CACHE_MAX_SIZE) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.cache.set(normalizedSelector, {
        signatures,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return signatures;
    } catch (error) {
      console.error(`4byte lookup failed for ${normalizedSelector}:`, error);
      return [];
    }
  }

  /**
   * Look up multiple selectors in batch.
   *
   * Performs concurrent lookups with a concurrency limit to avoid
   * overwhelming the API. Results are returned as a Map from selector
   * to array of matching text signatures.
   *
   * @param selectors - Array of 4-byte hex selectors
   * @returns Map from selector to array of matching text signatures
   */
  public async lookupBatch(selectors: string[]): Promise<Map<string, string[]>> {
    const results = new Map<string, string[]>();

    // Deduplicate selectors
    const uniqueSelectors = [
      ...new Set(selectors.map((s) => this.normalizeSelector(s)).filter(Boolean)),
    ] as string[];

    // Process in chunks to respect concurrency limit
    for (let i = 0; i < uniqueSelectors.length; i += MAX_CONCURRENT_REQUESTS) {
      const chunk = uniqueSelectors.slice(i, i + MAX_CONCURRENT_REQUESTS);

      const promises = chunk.map(async (selector) => {
        const signatures = await this.lookup(selector);
        return { selector, signatures };
      });

      const chunkResults = await Promise.all(promises);

      for (const { selector, signatures } of chunkResults) {
        results.set(selector, signatures);
      }
    }

    // Map results back to the original selector format provided by the caller
    const finalResults = new Map<string, string[]>();
    for (const original of selectors) {
      const normalized = this.normalizeSelector(original);
      if (normalized && results.has(normalized)) {
        finalResults.set(original, results.get(normalized) || []);
      } else {
        finalResults.set(original, []);
      }
    }

    return finalResults;
  }

  /**
   * Clear the internal cache.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Normalize a selector to the 0x-prefixed lowercase 10-character format.
   *
   * @param selector - Raw selector string (with or without 0x prefix)
   * @returns Normalized selector string, or null if invalid
   */
  private normalizeSelector(selector: string): string | null {
    if (!selector) {
      return null;
    }

    // Remove 0x prefix if present
    let hex = selector.toLowerCase();
    if (hex.startsWith('0x')) {
      hex = hex.substring(2);
    }

    // Must be exactly 8 hex characters (4 bytes)
    if (!/^[0-9a-f]{8}$/.test(hex)) {
      return null;
    }

    return '0x' + hex;
  }

  /**
   * Extract text signatures from the 4byte.directory API response.
   *
   * The API returns paginated results with a `results` array. Each result
   * has a `text_signature` field containing the human-readable signature.
   *
   * @param response - Parsed JSON response from the API
   * @returns Array of text signature strings
   */
  private extractSignatures(response: {
    count?: number;
    results?: Array<{
      id?: number;
      text_signature?: string;
      hex_signature?: string;
    }>;
  }): string[] {
    if (!response || !Array.isArray(response.results)) {
      return [];
    }

    return response.results
      .map((entry) => entry.text_signature)
      .filter((sig): sig is string => typeof sig === 'string' && sig.length > 0);
  }

  /**
   * Perform an HTTPS GET request using Node's built-in https module.
   *
   * @param url - The URL to fetch
   * @returns Response body as a string, or null on error
   */
  private httpGet(url: string): Promise<string | null> {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);

      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Connection: 'keep-alive',
        },
        agent: fourByteAgent,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        // Handle redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          this.httpGet(res.headers.location).then(resolve);
          return;
        }

        // Handle non-2xx status codes
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          console.error(`4byte API returned status ${res.statusCode} for ${url}`);
          resolve(null);
          return;
        }

        let data = '';

        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', (err: Error) => {
        console.error(`4byte API request failed: ${err.message}`);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        console.error(`4byte API request timed out for ${url}`);
        resolve(null);
      });

      req.end();
    });
  }
}
