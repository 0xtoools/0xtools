/**
 * SolcManager - Centralized Solc-JS Loader with Caching
 *
 * This is the SINGLE source of truth for solc compiler instances.
 * Uses WASM solc-js for platform-independent, Remix-style behavior.
 *
 * Key properties:
 * - One compiler instance per version (no re-download)
 * - Safe for concurrent compiles
 * - Supports any pragma version
 * - Identical behavior on all platforms
 */

import * as semver from 'semver';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { keccak256 } from 'js-sha3';

// Lazy-loaded solc instance — not imported at top level to allow the extension
// to work even when the `solc` npm package is not installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _solc: any = null;

/**
 * `require` that escapes the webpack bundle. Downloaded soljson files live on
 * disk at runtime-determined paths, which webpack's `require` cannot resolve.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __non_webpack_require__: ((id: string) => any) | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeRequire(id: string): any {
  if (typeof __non_webpack_require__ === 'function') {
    return __non_webpack_require__(id);
  }
  // Unbundled contexts (jest / ts-node) only. createRequire gives a dynamic
  // require webpack's static analysis leaves alone — never eval: marketplace
  // malware scanners flag any eval in the shipped bundle.
  const { createRequire } = require('module') as typeof import('module');
  return createRequire(__filename)(id);
}

/**
 * Where downloaded soljson compilers are cached across sessions. The extension
 * points this at its globalStorage dir at activation; the CLI default keeps
 * compilers under the user's home so repeated runs never re-download.
 */
let _soljsonCacheDir = path.join(os.homedir(), '.0xtools', 'solc');

/** Cached list.json build metadata: full version tag → expected keccak256. */
let _releaseHashesPromise: Promise<Map<string, string>> | null = null;

let _solcReleaseTimer: ReturnType<typeof setTimeout> | null = null;
const SOLC_RELEASE_MS = 60_000; // Release solc after 60s of inactivity

function scheduleSolcRelease() {
  if (_solcReleaseTimer) {
    clearTimeout(_solcReleaseTimer);
  }
  _solcReleaseTimer = setTimeout(() => {
    _solc = null;
    _solcReleaseTimer = null;
    console.log('Released solc WASM module (idle timeout)');
  }, SOLC_RELEASE_MS);
}

function getSolc() {
  if (!_solc) {
    try {
      _solc = require('solc');
    } catch {
      // solc not installed — will be handled by callers
      return null;
    }
  }
  return _solc;
}

/** Minimal HTTPS GET → Buffer with redirect-following and a hard timeout. */
function httpsGetBuffer(url: string, timeoutMs: number, redirectsLeft = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const request = https.get(
      url,
      { timeout: timeoutMs },
      (response: import('http').IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          resolve(
            httpsGetBuffer(
              new URL(response.headers.location, url).toString(),
              timeoutMs,
              redirectsLeft - 1
            )
          );
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timed out fetching ${url}`));
    });
  });
}

// Try native solc binary on PATH
function tryNativeSolcVersion(): string | null {
  try {
    const { execSync } = require('child_process');
    const output = execSync('solc --version', { encoding: 'utf-8', timeout: 5000 });
    const match = output.match(/Version:\s*(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function compileWithNativeSolc(inputJson: string): string | null {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('solc', ['--standard-json'], {
      input: inputJson,
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Internal debug logger for SolcManager.
 * Avoids dependency on VS Code logger so this module works in CLI too.
 * Set SIGSCAN_DEBUG=1 to enable verbose output.
 */
const debug = {
  log: (msg: string, ...args: unknown[]) => {
    if (process.env.SIGSCAN_DEBUG) {
      console.log(`[SolcManager] ${msg}`, ...args);
    }
  },
  warn: (msg: string, ...args: unknown[]) => {
    console.warn(`[SolcManager] ${msg}`, ...args);
  },
};

// Type alias for solc instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SolcInstance = any;

/**
 * Available solc versions (fetched from solc-bin)
 * This is cached after first fetch
 */
let availableVersionsCache: string[] | null = null;
let availableVersionsPromise: Promise<string[]> | null = null;

/**
 * GasInfo - Remix-style gas information with AST location
 */
export interface GasInfo {
  name: string;
  selector: string;
  gas: number | 'infinite';
  loc: { line: number; endLine: number };
  visibility: string;
  stateMutability: string;
  warnings: string[];
}

/**
 * Compilation output with gas estimates and AST
 */
export interface CompilationOutput {
  success: boolean;
  version: string;
  gasInfo: GasInfo[];
  errors: string[];
  warnings: string[];
  /** Size of deployed bytecode in bytes (for EIP-170 24KB check). AST and full bytecode are NOT retained to save memory. */
  deployedBytecodeSize?: number;
}

/**
 * Compiler input settings
 */
export interface CompilerSettings {
  optimizer?: {
    enabled: boolean;
    runs: number;
  };
  evmVersion?: string;
  viaIR?: boolean;
}

/**
 * SolcManager - Centralized compiler management
 *
 * Usage:
 * ```ts
 * const compiler = await SolcManager.load('0.8.20');
 * const output = SolcManager.compile(source, compiler);
 * ```
 */
export class SolcManager {
  private static cache = new Map<string, SolcInstance>();
  private static loading = new Map<string, Promise<SolcInstance>>();
  /** Tracks last-used timestamp per cached version for TTL eviction */
  private static lastUsed = new Map<string, number>();
  /** TTL in ms — unload solc versions unused for 5 minutes */
  private static readonly TTL_MS = 5 * 60 * 1000;
  /** Max number of solc versions to keep in memory simultaneously */
  private static readonly MAX_CACHED = 1;
  /** Handle for the periodic eviction timer */
  private static evictionTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Load a specific solc version (cached)
   *
   * @param version - Semantic version (e.g., '0.8.20') or full version (e.g., 'v0.8.20+commit.xxx')
   * @returns Promise<SolcInstance> - The compiler instance
   */
  static async load(version: string): Promise<SolcInstance> {
    // Normalize version
    const normalizedVersion = this.normalizeVersion(version);

    // Check cache first
    if (this.cache.has(normalizedVersion)) {
      const cached = this.cache.get(normalizedVersion);
      if (cached) {
        this.touchVersion(normalizedVersion);
        return cached;
      }
    }

    // Check if already loading (prevent duplicate downloads)
    if (this.loading.has(normalizedVersion)) {
      const loading = this.loading.get(normalizedVersion);
      if (loading) {
        return loading;
      }
    }

    // Start loading. The compiler is fetched from binaries.soliditylang.org
    // into a persistent disk cache and wrapped with `solc/wrapper` (which is
    // bundled by webpack) — so neither the download nor the wrap needs the
    // full `solc` npm package with its ~9 MB bundled soljson.
    const loadPromise = this.loadFromDiskOrRemote(normalizedVersion)
      .then((solcInstance) => {
        this.loading.delete(normalizedVersion);
        debug.log(`Loaded solc ${normalizedVersion}`);
        // Evict excess cached versions before adding new one
        this.evictExcess(normalizedVersion);
        this.cache.set(normalizedVersion, solcInstance);
        this.touchVersion(normalizedVersion);
        this.startEvictionTimer();
        return solcInstance;
      })
      .catch((error: Error) => {
        this.loading.delete(normalizedVersion);
        console.error(`❌ Failed to load solc ${normalizedVersion}:`, error.message);
        throw new Error(`Failed to load solc ${normalizedVersion}: ${error.message}`);
      });

    this.loading.set(normalizedVersion, loadPromise);
    return loadPromise;
  }

  /**
   * Point the soljson disk cache somewhere else (the extension passes its
   * globalStorage path at activation). Created lazily on first download.
   */
  static setSoljsonCacheDir(dir: string): void {
    _soljsonCacheDir = dir;
  }

  /** Load a soljson from the disk cache, downloading it first when missing. */
  private static async loadFromDiskOrRemote(normalizedVersion: string): Promise<SolcInstance> {
    if (!/^v\d+\.\d+\.\d+\+commit\.[0-9a-f]+$/.test(normalizedVersion)) {
      throw new Error(`Unrecognized solc version format: ${normalizedVersion}`);
    }
    const file = path.join(_soljsonCacheDir, `soljson-${normalizedVersion}.js`);
    if (!fs.existsSync(file)) {
      await this.downloadSoljson(normalizedVersion, file);
    }

    const wrapperModule = require('solc/wrapper'); // small, bundled by webpack
    const wrap = wrapperModule.default ?? wrapperModule;
    try {
      return wrap(nodeRequire(file));
    } catch (error) {
      // A corrupt/partial cache entry should not brick this version forever.
      fs.rmSync(file, { force: true });
      throw error;
    }
  }

  /** Download one soljson build, verify it against list.json, write atomically. */
  private static async downloadSoljson(
    normalizedVersion: string,
    destination: string
  ): Promise<void> {
    const url = `https://binaries.soliditylang.org/bin/soljson-${normalizedVersion}.js`;
    debug.log(`Downloading ${url}`);
    const body = await httpsGetBuffer(url, 120_000);
    if (body.length < 1_000_000) {
      throw new Error(`Downloaded compiler is implausibly small (${body.length} bytes)`);
    }
    const expected = await this.getExpectedKeccak(normalizedVersion);
    if (expected) {
      const actual = `0x${keccak256(body)}`;
      if (actual !== expected.toLowerCase()) {
        throw new Error(
          `Compiler download failed integrity check (keccak ${actual} ≠ ${expected})`
        );
      }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const tmp = `${destination}.download-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, destination);
  }

  /** Expected keccak256 for a build, from list.json (null when unavailable/offline). */
  private static async getExpectedKeccak(normalizedVersion: string): Promise<string | null> {
    if (!_releaseHashesPromise) {
      _releaseHashesPromise = httpsGetBuffer(
        'https://binaries.soliditylang.org/bin/list.json',
        15_000
      )
        .then((buffer) => {
          const hashes = new Map<string, string>();
          const json = JSON.parse(buffer.toString('utf8')) as {
            builds?: Array<{ path?: string; keccak256?: string }>;
          };
          for (const build of json.builds ?? []) {
            if (build.path && build.keccak256) {
              const version = build.path.replace(/^soljson-/, '').replace(/\.js$/, '');
              hashes.set(version, build.keccak256);
            }
          }
          return hashes;
        })
        .catch(() => new Map<string, string>());
    }
    const hashes = await _releaseHashesPromise;
    return hashes.get(normalizedVersion) ?? null;
  }

  /**
   * Get the bundled solc version (synchronous, returns null if solc not installed)
   */
  static getBundled(): SolcInstance | null {
    return getSolc();
  }

  /**
   * Get bundled version string
   */
  static getBundledVersion(): string {
    const solcModule = getSolc();
    if (solcModule) {
      return solcModule.version();
    }
    const native = tryNativeSolcVersion();
    if (native) {
      return native;
    }
    return 'unknown';
  }

  /**
   * Check if a version is cached
   */
  static isCached(version: string): boolean {
    return this.cache.has(this.normalizeVersion(version));
  }

  /**
   * Get cached compiler (returns null if not cached)
   */
  static getCached(version: string): SolcInstance | null {
    const normalizedVersion = this.normalizeVersion(version);
    const instance = this.cache.get(normalizedVersion) || null;
    if (instance) {
      this.touchVersion(normalizedVersion);
    }
    return instance;
  }

  /**
   * Unload a specific solc version from memory
   */
  static unload(version: string): void {
    const normalizedVersion = this.normalizeVersion(version);
    if (this.cache.has(normalizedVersion)) {
      this.cache.delete(normalizedVersion);
      this.lastUsed.delete(normalizedVersion);
      debug.log(`Unloaded solc ${normalizedVersion}`);
    }
  }

  /**
   * Clear the cache (for testing or memory management)
   */
  static clearCache(): void {
    this.cache.clear();
    this.loading.clear();
    this.lastUsed.clear();
    this.stopEvictionTimer();
    debug.log('Cache cleared');
  }

  /**
   * Get all cached versions
   */
  static getCachedVersions(): string[] {
    return Array.from(this.cache.keys());
  }

  /** Mark a version as recently used */
  private static touchVersion(version: string): void {
    this.lastUsed.set(version, Date.now());
  }

  /**
   * Evict cached versions that exceed MAX_CACHED, keeping the most recently used.
   * Called before inserting a new version so we don't accumulate WASM instances.
   */
  private static evictExcess(excludeVersion?: string): void {
    // Only evict if we're at or over the limit
    if (this.cache.size < this.MAX_CACHED) {
      return;
    }

    // Sort by last-used ascending (oldest first)
    const entries = Array.from(this.cache.keys())
      .filter((v) => v !== excludeVersion)
      .sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));

    // Remove oldest until we're under the limit
    const toRemove = this.cache.size - this.MAX_CACHED + 1; // +1 to make room for the new one
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      debug.log(`Evicting solc ${entries[i]} (%.1f MB freed est.)`, 40);
      this.cache.delete(entries[i]);
      this.lastUsed.delete(entries[i]);
    }
  }

  /** Start the periodic TTL eviction timer (runs every 60s) */
  private static startEvictionTimer(): void {
    if (this.evictionTimer) {
      return;
    }
    this.evictionTimer = setInterval(() => {
      this.evictExpired();
    }, 60_000);
    // Unref so the timer doesn't prevent Node from exiting
    if (typeof this.evictionTimer === 'object' && 'unref' in this.evictionTimer) {
      this.evictionTimer.unref();
    }
  }

  /** Stop the eviction timer */
  private static stopEvictionTimer(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  /** Evict all versions that haven't been used within TTL_MS */
  private static evictExpired(): void {
    const now = Date.now();
    for (const [version, lastUsedTime] of this.lastUsed.entries()) {
      if (now - lastUsedTime > this.TTL_MS) {
        debug.log(`TTL expired for solc ${version} — unloading`);
        this.cache.delete(version);
        this.lastUsed.delete(version);
      }
    }
    // If nothing left cached, stop the timer
    if (this.cache.size === 0) {
      this.stopEvictionTimer();
    }
  }

  /**
   * Normalize version string to solc-bin format
   */
  private static normalizeVersion(version: string): string {
    // Already in full format
    if (version.startsWith('v') && version.includes('+commit')) {
      return version;
    }

    // Map short versions to full versions
    const versionMap: Record<string, string> = {
      '0.8.28': 'v0.8.28+commit.7893614a',
      '0.8.27': 'v0.8.27+commit.40a35a09',
      '0.8.26': 'v0.8.26+commit.8a97fa7a',
      '0.8.25': 'v0.8.25+commit.b61c2a91',
      '0.8.24': 'v0.8.24+commit.e11b9ed9',
      '0.8.23': 'v0.8.23+commit.f704f362',
      '0.8.22': 'v0.8.22+commit.4fc1097e',
      '0.8.21': 'v0.8.21+commit.d9974bed',
      '0.8.20': 'v0.8.20+commit.a1b79de6',
      '0.8.19': 'v0.8.19+commit.7dd6d404',
      '0.8.18': 'v0.8.18+commit.87f61d96',
      '0.8.17': 'v0.8.17+commit.8df45f5f',
      '0.8.16': 'v0.8.16+commit.07a7930e',
      '0.8.15': 'v0.8.15+commit.e14f2714',
      '0.8.14': 'v0.8.14+commit.80d49f37',
      '0.8.13': 'v0.8.13+commit.abaa5c0e',
      '0.8.12': 'v0.8.12+commit.f00d7308',
      '0.8.11': 'v0.8.11+commit.d7f03943',
      '0.8.10': 'v0.8.10+commit.fc410830',
      '0.8.9': 'v0.8.9+commit.e5eed63a',
      '0.8.8': 'v0.8.8+commit.dddeac2f',
      '0.8.7': 'v0.8.7+commit.e28d00a7',
      '0.8.6': 'v0.8.6+commit.11564f7e',
      '0.8.5': 'v0.8.5+commit.a4f2e591',
      '0.8.4': 'v0.8.4+commit.c7e474f2',
      '0.8.3': 'v0.8.3+commit.8d00100c',
      '0.8.2': 'v0.8.2+commit.661d1103',
      '0.8.1': 'v0.8.1+commit.df193b15',
      '0.8.0': 'v0.8.0+commit.c7dfd78e',
      '0.7.6': 'v0.7.6+commit.7338295f',
      '0.7.5': 'v0.7.5+commit.eb77ed08',
      '0.7.4': 'v0.7.4+commit.3f05b770',
      '0.7.3': 'v0.7.3+commit.9bfce1f6',
      '0.7.2': 'v0.7.2+commit.51b20bc0',
      '0.7.1': 'v0.7.1+commit.f4a555be',
      '0.7.0': 'v0.7.0+commit.9e61f92b',
      '0.6.12': 'v0.6.12+commit.27d51765',
      '0.6.11': 'v0.6.11+commit.5ef660b1',
      '0.6.10': 'v0.6.10+commit.00c0fcaf',
      '0.6.9': 'v0.6.9+commit.3e3065ac',
      '0.6.8': 'v0.6.8+commit.0bbfe453',
      '0.6.7': 'v0.6.7+commit.b8d736ae',
      '0.6.6': 'v0.6.6+commit.6c089d02',
      '0.5.17': 'v0.5.17+commit.d19bba13',
      '0.5.16': 'v0.5.16+commit.9c3226ce',
      '0.4.26': 'v0.4.26+commit.4563c3fc',
    };

    // Strip 'v' prefix if present
    const cleanVersion = version.replace(/^v/, '');

    if (versionMap[cleanVersion]) {
      return versionMap[cleanVersion];
    }

    // Return as-is and let solc handle it
    return version.startsWith('v') ? version : `v${version}`;
  }

  /**
   * Fetch available solc versions from solc-bin
   * Results are cached after first fetch
   */
  static async getAvailableVersions(): Promise<string[]> {
    if (availableVersionsCache) {
      return availableVersionsCache;
    }

    if (availableVersionsPromise) {
      return availableVersionsPromise;
    }

    availableVersionsPromise = new Promise((resolve) => {
      try {
        // solc-js has a method to get version list

        const https = require('https');
        const url = 'https://binaries.soliditylang.org/bin/list.json';

        const req = https

          .get(url, (res: { on: (event: string, callback: (data?: string) => void) => void }) => {
            let data = '';
            res.on('data', (chunk?: string) => {
              if (chunk) {
                data += chunk;
              }
            });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const versions = Object.keys(json.releases).map((v: string) => v.replace('v', ''));
                availableVersionsCache = versions;
                resolve(versions);
              } catch {
                // Fallback to hardcoded versions
                availableVersionsCache = this.getHardcodedVersions();
                resolve(availableVersionsCache);
              }
            });
          })
          .on('error', () => {
            availableVersionsCache = this.getHardcodedVersions();
            resolve(availableVersionsCache);
          });

        // Timeout after 10 seconds — fall back to hardcoded versions
        req.setTimeout(10_000, () => {
          req.destroy();
          availableVersionsCache = this.getHardcodedVersions();
          resolve(availableVersionsCache!);
        });
      } catch {
        availableVersionsCache = this.getHardcodedVersions();
        resolve(availableVersionsCache);
      }
    });

    return availableVersionsPromise;
  }

  /**
   * Hardcoded version list (fallback when network unavailable).
   * Exposed so pragma resolution can try this offline list before hitting the
   * network in {@link getAvailableVersions}.
   */
  static getHardcodedVersions(): string[] {
    return [
      '0.8.28',
      '0.8.27',
      '0.8.26',
      '0.8.25',
      '0.8.24',
      '0.8.23',
      '0.8.22',
      '0.8.21',
      '0.8.20',
      '0.8.19',
      '0.8.18',
      '0.8.17',
      '0.8.16',
      '0.8.15',
      '0.8.14',
      '0.8.13',
      '0.8.12',
      '0.8.11',
      '0.8.10',
      '0.8.9',
      '0.8.8',
      '0.8.7',
      '0.8.6',
      '0.8.5',
      '0.8.4',
      '0.8.3',
      '0.8.2',
      '0.8.1',
      '0.8.0',
      '0.7.6',
      '0.7.5',
      '0.7.4',
      '0.7.3',
      '0.7.2',
      '0.7.1',
      '0.7.0',
      '0.6.12',
      '0.6.11',
      '0.6.10',
      '0.6.9',
      '0.6.8',
      '0.6.7',
      '0.6.6',
      '0.5.17',
      '0.5.16',
      '0.4.26',
    ];
  }
}

/**
 * Resolve the highest compatible solc version for a pragma
 * This is Remix behavior - always use the highest compatible version
 *
 * @param pragma - Pragma string (e.g., '^0.8.20', '>=0.8.0 <0.9.0')
 * @param availableVersions - List of available versions
 * @returns The highest compatible version
 */
export function resolveSolcVersion(pragma: string, availableVersions: string[]): string {
  // Clean the pragma string
  const clean = pragma
    .replace(/pragma\s+solidity/i, '')
    .replace(';', '')
    .trim();

  // Find all compatible versions
  const candidates = availableVersions.filter((v) => {
    try {
      return semver.satisfies(v, clean);
    } catch {
      return false;
    }
  });

  if (!candidates.length) {
    throw new Error(`No compiler available for pragma: ${clean}`);
  }

  // Return the highest compatible version (Remix behavior)
  return semver.rsort([...candidates])[0];
}

/**
 * Parse pragma from source code
 */
export function parsePragmaFromSource(source: string): string | null {
  const match = source.match(/pragma\s+solidity\s+([^;]+);/i);
  return match ? match[1].trim() : null;
}

/**
 * Get the best compiler for source code
 * Resolves pragma and returns the appropriate compiler
 */
export async function getCompilerForPragma(source: string): Promise<{
  compiler: SolcInstance;
  version: string;
  isExact: boolean;
}> {
  const pragma = parsePragmaFromSource(source);
  const bundled = SolcManager.getBundled();

  if (!pragma) {
    // No pragma — use bundled when present, otherwise the newest known release.
    if (bundled) {
      return {
        compiler: bundled,
        version: SolcManager.getBundledVersion(),
        isExact: true,
      };
    }
    const fallbackVersion = SolcManager.getHardcodedVersions()[0];
    return {
      compiler: await SolcManager.load(fallbackVersion),
      version: fallbackVersion,
      isExact: false,
    };
  }

  try {
    const bundledVersion = SolcManager.getBundledVersion();
    const bundledSemver = (bundled && bundledVersion.match(/(\d+\.\d+\.\d+)/)?.[1]) || '';

    // Resolve the target version WITHOUT a network fetch when possible.
    // The bundled compiler and the hardcoded version list cover the common case;
    // only fall through to the remote list (an HTTPS GET with a 10s timeout) when
    // neither offline source satisfies the pragma. We include the bundled version
    // in the offline candidate set so resolveSolcVersion still picks the highest
    // compatible version (preserving "use the newest matching compiler").
    const cleanPragma = pragma
      .replace(/pragma\s+solidity/i, '')
      .replace(';', '')
      .trim();
    let targetVersion: string | null = null;

    const offlineCandidates = [
      ...(bundledSemver ? [bundledSemver] : []),
      ...SolcManager.getHardcodedVersions(),
    ];
    const offlineSatisfies = offlineCandidates.some((v) => {
      try {
        return semver.satisfies(v, cleanPragma);
      } catch {
        return false;
      }
    });
    if (offlineSatisfies) {
      targetVersion = resolveSolcVersion(pragma, offlineCandidates);
    } else {
      // No bundled/hardcoded version matches — fall back to the remote list.
      const availableVersions = await SolcManager.getAvailableVersions();
      targetVersion = resolveSolcVersion(pragma, availableVersions);
    }

    if (bundled && bundledSemver && targetVersion === bundledSemver) {
      return {
        compiler: bundled,
        version: bundledVersion,
        isExact: true,
      };
    }

    // Check cache
    if (SolcManager.isCached(targetVersion)) {
      const cached = SolcManager.getCached(targetVersion);
      if (cached) {
        return {
          compiler: cached,
          version: targetVersion,
          isExact: true,
        };
      }
    }

    // Load the exact version
    const compiler = await SolcManager.load(targetVersion);
    return {
      compiler,
      version: targetVersion,
      isExact: true,
    };
  } catch (error) {
    // Fallback to bundled
    console.warn(`Could not resolve pragma ${pragma}, using bundled:`, error);
    if (!bundled) {
      throw new Error(
        `No solc compiler available for pragma ${pragma} — the download from binaries.soliditylang.org failed ` +
          `(offline?) and no bundled/native solc is installed. Original error: ${(error as Error).message}`
      );
    }
    return {
      compiler: bundled,
      version: SolcManager.getBundledVersion(),
      isExact: false,
    };
  }
}

/**
 * Standard-JSON settings are version-gated: solc rejects the ENTIRE input when
 * it sees a key or value it does not know (`viaIR` before 0.8.13, `evmVersion:
 * "paris"` before 0.8.18), which silently killed gas analysis for every
 * older-pragma project. Minimum solc version per evmVersion name:
 */
const EVM_VERSION_MIN_SOLC: Record<string, string> = {
  istanbul: '0.5.14',
  berlin: '0.8.5',
  london: '0.8.7',
  paris: '0.8.18',
  shanghai: '0.8.20',
  cancun: '0.8.24',
  prague: '0.8.27',
};
const VIA_IR_MIN_SOLC = '0.8.13';

/** Extract the bare semver from any solc version string ('v0.6.6+commit.x' → '0.6.6'). */
function semverOfSolc(version: string | undefined): string | null {
  return version?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/**
 * Compile source with correct outputs for gas analysis
 * Returns gas estimates, AST, and bytecode
 *
 * `solcVersion` is the compiler the input will be fed to; settings keys that
 * version does not understand are omitted (solc then uses its own defaults).
 * When the version is unknown, every gated key is omitted so the input stays
 * valid for any compiler.
 */
export function createCompilationInput(
  fileName: string,
  source: string,
  settings?: CompilerSettings,
  solcVersion?: string
): object {
  const optimizerSettings = settings?.optimizer ?? { enabled: true, runs: 200 };
  const target = semverOfSolc(solcVersion);

  let evmVersion: string | undefined = settings?.evmVersion;
  if (evmVersion === undefined) {
    evmVersion = target && semver.gte(target, EVM_VERSION_MIN_SOLC['paris']) ? 'paris' : undefined;
  } else {
    const min = EVM_VERSION_MIN_SOLC[evmVersion];
    if (!target || (min !== undefined && semver.lt(target, min))) {
      debug.log(`evmVersion "${evmVersion}" not supported by solc ${solcVersion}; omitted`);
      evmVersion = undefined;
    }
  }

  // viaIR: false is the compiler default everywhere, so the key is only ever
  // needed when explicitly enabled on a compiler that knows it.
  const viaIR =
    settings?.viaIR === true && target !== null && semver.gte(target, VIA_IR_MIN_SOLC)
      ? true
      : undefined;

  return {
    language: 'Solidity',
    sources: {
      [fileName]: { content: source },
    },
    settings: {
      optimizer: optimizerSettings,
      ...(evmVersion !== undefined ? { evmVersion } : {}),
      ...(viaIR !== undefined ? { viaIR } : {}),
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'evm.gasEstimates',
            'evm.bytecode.object',
            'evm.deployedBytecode.object',
            'metadata',
          ],
          '': ['ast'],
        },
      },
    },
  };
}

/**
 * Compute function selector from AST node (Remix-style)
 * Handles overloads, struct types, arrays correctly
 */
export function computeSelector(fnNode: ASTFunctionNode): string {
  // Get canonical parameter types
  const args = fnNode.parameters.parameters
    .map((p: ASTParameter) => {
      // Use typeDescriptions.typeString for canonical type
      let type = p.typeDescriptions?.typeString || p.typeName?.name || 'unknown';

      // Normalize types
      type = normalizeType(type);

      return type;
    })
    .join(',');

  const sig = `${fnNode.name}(${args})`;
  const hash = keccak256(sig);
  return '0x' + hash.substring(0, 8);
}

/**
 * Normalize Solidity type for selector computation
 */
function normalizeType(type: string): string {
  // Remove 'contract ', 'struct ', 'enum ' prefixes (including library-qualified names)
  // e.g. "contract IERC20" → "IERC20", "struct MyLib.MyStruct" → "MyLib.MyStruct"
  type = type.replace(/^(contract|struct|enum)\s+/, '');

  // Strip library/contract qualifier from struct names: "MyLib.MyStruct" → "MyStruct"
  // But preserve array brackets if present: "MyLib.MyStruct[]" → "MyStruct[]"
  type = type.replace(/^(\w+\.)+/, '');

  // Handle memory/storage/calldata
  type = type.replace(/\s+(memory|storage|calldata)$/, '');

  // "address payable" → "address"
  type = type.replace(/^address\s+payable$/, 'address');

  // Normalize shorthand integer types: "uint" → "uint256", "int" → "int256"
  // Must be exact matches, not substrings like "uint8"
  type = type.replace(/^uint$/, 'uint256');
  type = type.replace(/^int$/, 'int256');

  // Same for array variants: "uint[]" → "uint256[]"
  type = type.replace(/^uint(\[)/, 'uint256$1');
  type = type.replace(/^int(\[)/, 'int256$1');

  // Handle mappings (shouldn't appear in function params, but just in case)
  if (type.startsWith('mapping(')) {
    return 'mapping';
  }

  // Handle tuple types from AST: "tuple(uint256,address)" stays as-is
  // These come from struct parameters that solc expands

  // Collapse remaining whitespace (e.g. inside array dimensions)
  type = type.replace(/\s+/g, '');

  return type;
}

// AST type definitions
interface ASTParameter {
  name: string;
  typeName?: { name: string };
  typeDescriptions?: { typeString: string };
}

interface ASTFunctionNode {
  nodeType: string;
  name: string;
  visibility: string;
  stateMutability: string;
  parameters: { parameters: ASTParameter[] };
  body?: { statements?: unknown[] };
  src: string;
}

interface ASTNode {
  nodeType?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Build a line-offset table from source without retaining a split lines array.
 * Returns an array where lineOffsets[i] is the character offset of line i (0-based lines).
 * The final entry equals sourceCode.length + 1, so binary-search works for any offset.
 */
function buildLineOffsets(sourceCode: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < sourceCode.length; i++) {
    if (sourceCode.charCodeAt(i) === 10 /* \n */) {
      offsets.push(i + 1);
    }
  }
  // Sentinel so the last line is searchable
  offsets.push(sourceCode.length + 1);
  return offsets;
}

/**
 * Convert a character offset to a 1-based line number using binary search.
 */
function offsetToLine(offset: number, lineOffsets: number[]): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1; // 1-based
}

/**
 * Map gas estimates to AST function locations (Remix-style)
 *
 * This is the core of the gas-to-source mapping system.
 * It walks the AST, finds function definitions, and matches them
 * with gas estimates from solc output.
 */
export function mapGasToAst(
  ast: ASTNode,
  gasEstimates: Record<string, unknown>,
  sourceCode: string,
  contractName?: string
): GasInfo[] {
  const results: GasInfo[] = [];

  debug.log(
    `mapGasToAst: nodeType=${ast?.nodeType}, contract=${contractName || '(all)'}, keys=${JSON.stringify(gasEstimates).substring(0, 200)}`
  );

  // Build line offset map for src parsing (no intermediate lines array)
  const lineOffsets = buildLineOffsets(sourceCode);

  // Track the current contract name as we walk the AST
  let currentContract: string | null = null;

  function walk(node: ASTNode): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    // Track which ContractDefinition we're inside
    const isContractNode = node.nodeType === 'ContractDefinition' && typeof node.name === 'string';
    const previousContract = currentContract;
    if (isContractNode) {
      currentContract = node.name as string;
      // If caller specified a contractName, skip contracts that don't match
      if (contractName && currentContract !== contractName) {
        // Still recurse past this contract in case of nested types,
        // but restore contract name after
        currentContract = previousContract;
        return;
      }
    }

    if (node.nodeType === 'FunctionDefinition' && node.name) {
      const fnNode = node as unknown as ASTFunctionNode;

      // Parse src: "start:length:fileIndex"
      const srcParts = fnNode.src.split(':');
      const startOffset = parseInt(srcParts[0], 10);
      const length = parseInt(srcParts[1], 10);
      const startLine = offsetToLine(startOffset, lineOffsets);
      const endLine = offsetToLine(startOffset + length, lineOffsets);

      // Compute selector
      const selector = computeSelector(fnNode);

      // Find gas data - try multiple matching strategies
      let gas: number | 'infinite' = 0;
      const gasData = findGasForFunction(fnNode, gasEstimates);
      if (gasData !== null) {
        gas = gasData;
      }

      const warnings: string[] = [];

      results.push({
        name: fnNode.name,
        selector,
        gas,
        loc: { line: startLine, endLine },
        visibility: fnNode.visibility || 'internal',
        stateMutability: fnNode.stateMutability || 'nonpayable',
        warnings,
      });
    }

    // Recurse into child nodes
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          value.forEach((child) => walk(child as ASTNode));
        } else {
          walk(value as ASTNode);
        }
      }
    }

    // Restore contract context when leaving a ContractDefinition
    if (isContractNode) {
      currentContract = previousContract;
    }
  }

  walk(ast);
  return results;
}

/**
 * Parse a gas value from solc output (string number, literal "infinite", or number)
 */
function parseGasValue(value: unknown): number | 'infinite' | null {
  if (value === 'infinite') {
    return 'infinite';
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'number') {
    return value;
  }
  return null;
}

/**
 * Find gas estimate for a function from solc output.
 *
 * Matching strategy (in order):
 * 1. Exact signature match
 * 2. Case-insensitive signature match
 * 3. Name-only match (only when there's exactly one match to avoid overload ambiguity)
 */
function findGasForFunction(
  fnNode: ASTFunctionNode,
  gasEstimates: Record<string, unknown>
): number | 'infinite' | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const external = (gasEstimates as any)?.external || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = (gasEstimates as any)?.internal || {};

  // Build function signature from AST types
  const args = fnNode.parameters.parameters
    .map((p: ASTParameter) => normalizeType(p.typeDescriptions?.typeString || 'unknown'))
    .join(',');
  const signature = `${fnNode.name}(${args})`;

  const pools = [external, internal];

  // Strategy 1: Exact match
  for (const pool of pools) {
    if (pool[signature] !== undefined) {
      const result = parseGasValue(pool[signature]);
      if (result !== null) {
        return result;
      }
    }
    // Handle object format with min/max properties
    const poolVal = pool[signature];
    if (typeof poolVal === 'object' && poolVal !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gasObj = poolVal as any;
      // Return average of min and max
      if (gasObj.min !== undefined && gasObj.max !== undefined) {
        const min = gasObj.min === 'infinite' ? Infinity : Number(gasObj.min);
        const max = gasObj.max === 'infinite' ? Infinity : Number(gasObj.max);
        if (min === Infinity || max === Infinity) {
          return 'infinite';
        }
        return Math.round((min + max) / 2);
      }
    }
  }

  // Strategy 2: Case-insensitive signature match
  const sigLower = signature.toLowerCase();
  for (const pool of pools) {
    for (const [key, value] of Object.entries(pool)) {
      if (key.toLowerCase() === sigLower) {
        const result = parseGasValue(value);
        if (result !== null) {
          return result;
        }
        // Handle object format with min/max properties
        if (typeof value === 'object' && value !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const gasObj = value as any;
          // Return average of min and max
          if (gasObj.min !== undefined && gasObj.max !== undefined) {
            const min = gasObj.min === 'infinite' ? Infinity : Number(gasObj.min);
            const max = gasObj.max === 'infinite' ? Infinity : Number(gasObj.max);
            if (min === Infinity || max === Infinity) {
              return 'infinite';
            }
            return Math.round((min + max) / 2);
          }
        }
      }
    }
  }

  // Strategy 3: Name-only match — only if exactly one entry matches the name
  // This avoids ambiguity with overloaded functions
  const namePrefix = fnNode.name + '(';
  for (const pool of pools) {
    const nameMatches = Object.entries(pool).filter(([sig]) => sig.startsWith(namePrefix));
    if (nameMatches.length === 1) {
      const matchVal = nameMatches[0][1];
      const result = parseGasValue(matchVal);
      if (result !== null) {
        return result;
      }
      // Handle object format with min/max properties
      if (typeof matchVal === 'object' && matchVal !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gasObj = matchVal as any;
        // Return average of min and max
        if (gasObj.min !== undefined && gasObj.max !== undefined) {
          const min = gasObj.min === 'infinite' ? Infinity : Number(gasObj.min);
          const max = gasObj.max === 'infinite' ? Infinity : Number(gasObj.max);
          if (min === Infinity || max === Infinity) {
            return 'infinite';
          }
          return Math.round((min + max) / 2);
        }
      }
    }
  }

  return null;
}

/**
 * Detect infinite gas scenarios (Remix logic)
 *
 * Infinite gas is detected when:
 * - Loop condition depends on calldata
 * - External call inside loop
 * - Recursive calls
 * - Unbounded storage iteration
 */
function _detectInfiniteGasWarnings(fnNode: ASTFunctionNode, functionSource: string): string[] {
  const warnings: string[] = [];

  // Check for loops with external calls
  const hasLoop = /\b(for|while)\s*\(/.test(functionSource);
  const hasExternalCall = /\.\w+\s*\(/.test(functionSource);
  const hasDelegate = /delegatecall\s*\(/.test(functionSource);
  const hasStorageWrite = /\[\s*\w+\s*\]\s*=/.test(functionSource);

  if (hasLoop && hasExternalCall) {
    warnings.push('⚠️ external call inside loop');
  }

  if (hasLoop && hasStorageWrite) {
    warnings.push('⚠️ dynamic storage write in loop');
  }

  if (hasDelegate) {
    warnings.push('⚠️ delegatecall detected');
  }

  // Check for unbounded loops (loop variable from parameter)
  const loopMatch = functionSource.match(/for\s*\(\s*\w+\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*(\w+)/);
  if (loopMatch) {
    const boundVar = loopMatch[1];
    // Check if bound is a parameter
    const isParam = fnNode.parameters.parameters.some((p: ASTParameter) => p.name === boundVar);
    if (isParam) {
      warnings.push('⚠️ loop bound from calldata');
    }
  }

  // Check for recursive calls (simple heuristic)
  const fnName = fnNode.name;
  const recursivePattern = new RegExp(`\\b${fnName}\\s*\\(`);
  if (recursivePattern.test(functionSource)) {
    warnings.push('⚠️ possible recursion');
  }

  return warnings;
}

/**
 * Extract function info from source using regex (fallback when compilation fails)
 * This provides selectors even when imports are missing or code doesn't compile
 */
function extractFunctionsWithRegex(source: string): GasInfo[] {
  const results: GasInfo[] = [];

  // Build line offset map for finding line numbers (no intermediate lines array)
  const lineOffsets = buildLineOffsets(source);

  // Regex to match function declarations
  const functionRegex =
    /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?\s*(?:virtual)?\s*(?:override(?:\([^)]*\))?)?\s*(?:returns\s*\([^)]*\))?\s*[{;]/gs;

  let match;
  while ((match = functionRegex.exec(source)) !== null) {
    const [fullMatch, name, paramsStr, visibility = 'internal', stateMutability = 'nonpayable'] =
      match;
    const startOffset = match.index;

    // Find the end of the function (simplified - look for matching brace or semicolon)
    let endOffset = startOffset + fullMatch.length;
    if (fullMatch.endsWith('{')) {
      let braceCount = 1;
      let i = endOffset;
      while (i < source.length && braceCount > 0) {
        if (source[i] === '{') {
          braceCount++;
        } else if (source[i] === '}') {
          braceCount--;
        }
        i++;
      }
      endOffset = i;
    }

    // Parse parameters and normalize types
    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const parts = param.split(/\s+/).filter((p) => p.length > 0);
        if (parts.length >= 1) {
          // Extract type, handling memory/storage/calldata keywords
          let type = parts[0];
          // Remove memory/storage/calldata if it's the second part
          if (parts.length > 1 && ['memory', 'storage', 'calldata'].includes(parts[1])) {
            // Type is already correct
          }
          // Normalize type
          type = type.replace(/^(contract|struct|enum)\s+/, '');
          return type;
        }
        return 'unknown';
      });

    const signature = `${name}(${params.join(',')})`;
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    const startLine = offsetToLine(startOffset, lineOffsets);
    const endLine = offsetToLine(endOffset, lineOffsets);

    results.push({
      name,
      selector,
      gas: 0, // Unknown - compilation failed
      loc: { line: startLine, endLine },
      visibility: visibility || 'internal',
      stateMutability: stateMutability || 'nonpayable',
      warnings: ['⚠️ Gas unavailable - compilation failed (check imports)'],
    });
  }

  // Also extract constructor
  const constructorRegex = /constructor\s*\(([^)]*)\)\s*(public|internal)?\s*(payable)?\s*[{]/gs;
  let constructorMatch;
  while ((constructorMatch = constructorRegex.exec(source)) !== null) {
    const [, paramsStr, visibility = 'public', payable] = constructorMatch;
    const startOffset = constructorMatch.index;

    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const parts = param.split(/\s+/).filter((p) => p.length > 0);
        return parts[0] || 'unknown';
      });

    const signature = `constructor(${params.join(',')})`;
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    const startLine = offsetToLine(startOffset, lineOffsets);

    results.push({
      name: 'constructor',
      selector,
      gas: 0,
      loc: { line: startLine, endLine: startLine + 5 },
      visibility: visibility || 'public',
      stateMutability: payable === 'payable' ? 'payable' : 'nonpayable',
      warnings: ['⚠️ Gas unavailable - compilation failed (check imports)'],
    });
  }

  return results;
}

/**
 * Compile and get full gas analysis (Remix-style)
 * Falls back to regex-based parsing when compilation fails to still provide selectors
 */
export async function compileWithGasAnalysis(
  source: string,
  fileName = 'Contract.sol',
  settings?: CompilerSettings,
  importCallback?: (path: string) => { contents: string } | { error: string }
): Promise<CompilationOutput> {
  try {
    // The input is built AFTER the compiler version is known: its settings
    // keys are gated on that version (see createCompilationInput).
    let inputJson: string | null = null;
    let outputJson: string | null;
    let version: string;

    // Try solc-js first, then native solc
    try {
      const resolved = await getCompilerForPragma(source);
      version = resolved.version;

      if (!resolved.isExact) {
        console.warn(`Using fallback compiler version: ${version}`);
      }

      inputJson = JSON.stringify(createCompilationInput(fileName, source, settings, version));
      outputJson = importCallback
        ? resolved.compiler.compile(inputJson, { import: importCallback })
        : resolved.compiler.compile(inputJson);
    } catch (solcJsError) {
      // solc-js not available: try the native solc binary, but only when its
      // version actually satisfies the file's pragma: compiling 0.6.x source
      // with a native 0.8.x only manufactures a ParserError that hides the
      // real failure reported here.
      const reason = (solcJsError as Error).message;
      console.warn(`solc-js compilation unavailable: ${reason}`);
      const nativeVersion = tryNativeSolcVersion();
      const pragma = parsePragmaFromSource(source);
      let nativeCompatible = nativeVersion !== null;
      if (nativeCompatible && pragma) {
        try {
          nativeCompatible = semver.satisfies(nativeVersion!, pragma);
        } catch {
          nativeCompatible = false;
        }
      }
      const nativeResult = nativeCompatible
        ? compileWithNativeSolc(
            JSON.stringify(createCompilationInput(fileName, source, settings, nativeVersion!))
          )
        : null;
      if (nativeResult) {
        outputJson = nativeResult;
        version = nativeVersion!;
      } else {
        // No usable compiler: regex fallback, surfacing the real error
        inputJson = null;
        const fallbackGasInfo = extractFunctionsWithRegex(source);
        const nativeNote =
          nativeVersion && !nativeCompatible
            ? ` (native solc ${nativeVersion} does not satisfy pragma ${pragma})`
            : '';
        return {
          success: false,
          version: 'none',
          gasInfo: fallbackGasInfo,
          errors: [`No usable Solidity compiler for this file: ${reason}${nativeNote}`],
          warnings: [],
        };
      }
    }

    // Release the input JSON — no longer needed after compilation
    inputJson = null;

    // Parse and immediately release the raw JSON string to free memory
    let output = JSON.parse(outputJson!);
    outputJson = null; // Release raw JSON (can be 5-20MB)

    // Check for errors
    const errors: string[] = [];
    const warnings: string[] = [];

    if (output.errors) {
      for (const err of output.errors) {
        if (err.severity === 'error') {
          errors.push(err.formattedMessage || err.message);
        } else {
          warnings.push(err.formattedMessage || err.message);
        }
      }
    }

    if (errors.length > 0) {
      // Compilation failed - release solc output and fall back to regex
      output = null;
      console.warn(
        `⚠️ Compilation failed, falling back to regex-based selector extraction for ${fileName}`
      );
      const fallbackGasInfo = extractFunctionsWithRegex(source);
      debug.log(`Extracted ${fallbackGasInfo.length} functions via regex fallback`);

      return {
        success: false,
        version,
        gasInfo: fallbackGasInfo, // Still provide selectors even though compilation failed
        errors,
        warnings,
      };
    }

    // Extract gas info from AST — use `let` so references can be released
    const gasInfo: GasInfo[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let contracts: Record<string, any> = output.contracts?.[fileName] || {};
    let ast: ASTNode | undefined = output.sources?.[fileName]?.ast;

    debug.log(`Contracts found: ${Object.keys(contracts).length}, AST present: ${!!ast}`);

    for (const [cName, contractData] of Object.entries(contracts)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = contractData as any;
      const gasEstimates = data.evm?.gasEstimates || {};

      debug.log(`Contract: ${cName}, gasEstimates keys: ${Object.keys(gasEstimates).join(', ')}`);

      if (ast) {
        const mappedGas = mapGasToAst(ast, gasEstimates, source, cName);
        debug.log(`Mapped ${mappedGas.length} functions for ${cName}`);
        gasInfo.push(...mappedGas);
      }
    }

    // Compute deployed bytecode size for EIP-170 check (don't retain the full string)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstContract = Object.values(contracts)[0] as any;
    const deployedBytecodeHex: string | undefined = firstContract?.evm?.deployedBytecode?.object;
    let deployedBytecodeSize: number | undefined;
    if (deployedBytecodeHex) {
      const hex = deployedBytecodeHex.startsWith('0x')
        ? deployedBytecodeHex.slice(2)
        : deployedBytecodeHex;
      deployedBytecodeSize = hex.length / 2;
    }

    // Release the entire solc output and extracted references so GC can reclaim
    // AST, bytecodes, ABI, metadata, and all contract data
    output = null;
    contracts = null as any;
    ast = undefined;

    scheduleSolcRelease();
    return {
      success: true,
      version,
      gasInfo,
      errors: [],
      warnings,
      deployedBytecodeSize,
    };
  } catch (error) {
    // Last resort: regex fallback so we at least show selectors
    const fallbackGasInfo = extractFunctionsWithRegex(source);
    return {
      success: false,
      version: 'unknown',
      gasInfo: fallbackGasInfo,
      errors: [error instanceof Error ? error.message : 'Unknown compilation error'],
      warnings: [],
    };
  }
}
