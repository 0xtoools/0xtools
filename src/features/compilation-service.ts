/**
 * Compilation Service - Centralized compiler lifecycle management
 *
 * This is the SINGLE entry point for all compilation operations.
 * Solidity-specific logic is isolated here, UI never triggers compilation directly.
 * Every expensive operation is cached and debounced.
 *
 * Architecture (mirrors Remix):
 * - Compiler + Analysis split
 * - Debounced compilation (250-500ms)
 * - Cache by content hash
 * - Background version downloading
 * - Event-driven UI updates
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  SolcManager,
  GasInfo,
  CompilationOutput,
  CompilerSettings,
  compileWithGasAnalysis,
  parsePragmaFromSource,
  resolveSolcVersion,
} from './SolcManager';
import { isForgeAvailable, findFoundryRoot, compileWithForge } from './forge-backend';
import { isRunnerAvailable, compileWithRunner } from './runner-backend';

/**
 * Compilation event types
 */
export interface CompilationEvents {
  'compilation:start': { uri: string; version: string };
  'compilation:success': { uri: string; output: CompilationOutput };
  'compilation:error': { uri: string; errors: string[] };
  'version:downloading': { version: string };
  'version:ready': { version: string };
}

/**
 * Compilation trigger types
 */
export type CompilationTrigger =
  | 'file-save' // Recompile immediately
  | 'file-open' // Recompile immediately
  | 'optimizer-change' // Recompile with new settings
  | 'pragma-change' // Recompile with new solc version
  | 'manual'; // User-triggered

/**
 * Compilation result with metadata
 */
export interface CompilationResult extends CompilationOutput {
  uri: string;
  timestamp: number;
  trigger: CompilationTrigger;
  contentHash: string;
  cached: boolean;
}

/**
 * Cache entry
 */
interface CacheEntry {
  result: CompilationResult;
  timestamp: number;
  pragma: string | null;
}

/**
 * CompilationService - Manages the entire compilation lifecycle
 *
 * Usage:
 * ```ts
 * const service = CompilationService.getInstance();
 * service.on('compilation:success', (event) => {
 *   updateDecorations(event.output.gasInfo);
 * });
 * await service.compile(document.uri.toString(), source, 'file-save');
 * ```
 */
export class CompilationService extends EventEmitter {
  private static instance: CompilationService;

  // Caches
  private compilationCache = new Map<string, CacheEntry>(); // contentHash -> result
  private uriToHashCache = new Map<string, string>(); // uri -> contentHash (for quick lookup)

  // Debouncing
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private activeCompilations = new Map<string, Promise<CompilationResult>>();

  // Settings
  private settings: CompilerSettings = {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    viaIR: false,
  };

  // Debounce configuration
  private debounceMs = 300; // 250-500ms recommended

  // Cache limits
  private maxCacheSize = 100;
  private cacheExpiryMs = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): CompilationService {
    if (!this.instance) {
      this.instance = new CompilationService();
    }
    return this.instance;
  }

  /**
   * Update compiler settings
   */
  updateSettings(settings: Partial<CompilerSettings>): void {
    this.settings = { ...this.settings, ...settings };
    // Clear cache when settings change (optimizer affects gas estimates)
    this.clearCache();
  }

  /**
   * Get current settings
   */
  getSettings(): CompilerSettings {
    return { ...this.settings };
  }

  /**
   * Set debounce time in milliseconds
   */
  setDebounceMs(ms: number): void {
    this.debounceMs = Math.max(100, Math.min(1000, ms));
  }

  /**
   * Compile source code (debounced)
   *
   * @param uri - Document URI
   * @param source - Source code
   * @param trigger - What triggered this compilation
   * @param importCallback - Optional import resolver
   */
  async compile(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const contentHash = this.hashContent(source);

    // Check cache first
    const cached = this.getCached(contentHash);
    if (cached && !this.shouldRecompile(cached, trigger)) {
      return cached;
    }

    // Check if already compiling this exact content
    if (this.activeCompilations.has(contentHash)) {
      const existing = this.activeCompilations.get(contentHash);
      if (existing) {
        return existing;
      }
    }

    // Debounce based on trigger
    if (trigger === 'file-save' || trigger === 'file-open') {
      // Immediate compilation for save/open
      return this.compileNow(uri, source, trigger, contentHash, importCallback);
    }

    // Debounced compilation for other triggers
    return this.compileDebounced(uri, source, trigger, contentHash, importCallback);
  }

  /**
   * Compile immediately (no debounce)
   */
  async compileNow(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash?: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const hash = contentHash || this.hashContent(source);

    // Check cache
    const cached = this.getCached(hash);
    if (cached && !this.shouldRecompile(cached, trigger)) {
      return cached;
    }

    // Check if already compiling
    if (this.activeCompilations.has(hash)) {
      const existing = this.activeCompilations.get(hash);
      if (existing) {
        return existing;
      }
    }

    // Start compilation
    const compilationPromise = this.doCompile(uri, source, trigger, hash, importCallback);
    this.activeCompilations.set(hash, compilationPromise);

    try {
      const result = await compilationPromise;
      return result;
    } finally {
      this.activeCompilations.delete(hash);
    }
  }

  /**
   * Compile with debounce
   */
  private compileDebounced(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    return new Promise((resolve, reject) => {
      // Clear existing timer
      const existingTimer = this.debounceTimers.get(uri);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer
      const timer = setTimeout(async () => {
        this.debounceTimers.delete(uri);
        try {
          const result = await this.compileNow(uri, source, trigger, contentHash, importCallback);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, this.debounceMs);

      this.debounceTimers.set(uri, timer);
    });
  }

  /**
   * Do the actual compilation
   */
  private async doCompile(
    uri: string,
    source: string,
    trigger: CompilationTrigger,
    contentHash: string,
    importCallback?: (path: string) => { contents: string } | { error: string }
  ): Promise<CompilationResult> {
    const pragma = parsePragmaFromSource(source);
    const fileName = this.getFileName(uri);

    try {
      let output: CompilationOutput | null = null;

      const filePath = this.uriToFilePath(uri);
      const foundryRoot = filePath ? findFoundryRoot(filePath) : null;

      // --- Priority 1: Runner backend (EVM-executed gas, fastest) ---
      if (filePath && (await isRunnerAvailable())) {
        this.emit('compilation:start', { uri, version: 'runner' });
        try {
          output = await compileWithRunner(filePath, source);
          // If runner returned a fallback (success: false), clear output so next tier is tried
          if (output && !output.success) {
            output = null;
          }
        } catch {
          // Runner failed — fall through to forge/solc
          output = null;
        }
      }

      // --- Priority 2: Forge backend (Foundry projects) ---
      if (!output && foundryRoot && (await isForgeAvailable())) {
        this.emit('compilation:start', { uri, version: 'forge' });
        try {
          output = await compileWithForge(filePath!, foundryRoot);
          // If forge returned a fallback (success: false), clear output so solc is tried
          if (output && !output.success) {
            output = null;
          }
        } catch {
          output = null;
        }
      }

      // --- Priority 3: Solc-js (WASM, universal fallback) ---
      if (!output) {
        this.emit('compilation:start', { uri, version: pragma || 'bundled' });

        if (pragma) {
          const availableVersions = await SolcManager.getAvailableVersions();
          try {
            const targetVersion = resolveSolcVersion(pragma, availableVersions);
            if (!SolcManager.isCached(targetVersion)) {
              this.emit('version:downloading', { version: targetVersion });
              await SolcManager.load(targetVersion);
              this.emit('version:ready', { version: targetVersion });
            }
          } catch {
            // Will fall back to bundled
          }
        }

        output = await compileWithGasAnalysis(source, fileName, this.settings, importCallback);
      }

      const result: CompilationResult = {
        ...output,
        uri,
        timestamp: Date.now(),
        trigger,
        contentHash,
        cached: false,
      };

      // Cache the result
      this.cacheResult(contentHash, result, pragma);
      this.uriToHashCache.set(uri, contentHash);

      // Emit events - even on error, we may have fallback gasInfo
      if (result.success) {
        this.emit('compilation:success', { uri, output: result });
      } else {
        // Emit error event but also include the output (which may have fallback gasInfo)
        this.emit('compilation:error', { uri, errors: result.errors, output: result });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      const result: CompilationResult = {
        success: false,
        version: 'unknown',
        gasInfo: [],
        errors: [errorMsg],
        warnings: [],
        uri,
        timestamp: Date.now(),
        trigger,
        contentHash,
        cached: false,
      };

      this.emit('compilation:error', { uri, errors: result.errors });
      return result;
    }
  }

  /**
   * Try to convert a URI string to a local file path.
   * Returns null for non-file URIs.
   */
  private uriToFilePath(uri: string): string | null {
    if (uri.startsWith('file://')) {
      return decodeURIComponent(uri.replace('file://', ''));
    }
    // Already a path (no scheme)
    if (uri.startsWith('/') || /^[a-zA-Z]:/.test(uri)) {
      return uri;
    }
    return null;
  }

  /**
   * Get cached result
   */
  getCached(contentHash: string): CompilationResult | null {
    const entry = this.compilationCache.get(contentHash);
    if (!entry) {
      return null;
    }

    // Check expiry
    if (Date.now() - entry.timestamp > this.cacheExpiryMs) {
      this.compilationCache.delete(contentHash);
      return null;
    }

    // Return cached result with cached flag
    return { ...entry.result, cached: true };
  }

  /**
   * Get cached result by URI
   */
  getCachedByUri(uri: string): CompilationResult | null {
    const hash = this.uriToHashCache.get(uri);
    if (!hash) {
      return null;
    }
    return this.getCached(hash);
  }

  /**
   * Get gas info for a URI (from cache)
   */
  getGasInfo(uri: string): GasInfo[] {
    const result = this.getCachedByUri(uri);
    return result?.gasInfo || [];
  }

  /**
   * Check if we should recompile
   */
  private shouldRecompile(cached: CompilationResult, trigger: CompilationTrigger): boolean {
    // Always recompile on optimizer or pragma change
    if (trigger === 'optimizer-change' || trigger === 'pragma-change') {
      return true;
    }

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.cacheExpiryMs) {
      return true;
    }

    return false;
  }

  /**
   * Cache a compilation result
   */
  private cacheResult(contentHash: string, result: CompilationResult, pragma: string | null): void {
    // Enforce cache size limit
    if (this.compilationCache.size >= this.maxCacheSize) {
      this.evictOldest();
    }

    this.compilationCache.set(contentHash, {
      result,
      timestamp: Date.now(),
      pragma,
    });
  }

  /**
   * Evict oldest cache entries
   */
  private evictOldest(): void {
    const entries = Array.from(this.compilationCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest 20%
    const toRemove = Math.ceil(entries.length * 0.2);
    for (let i = 0; i < toRemove; i++) {
      this.compilationCache.delete(entries[i][0]);
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.compilationCache.clear();
    this.uriToHashCache.clear();
    console.log('🗑️  Compilation cache cleared');
  }

  /**
   * Cancel pending compilation for a URI
   */
  cancelPending(uri: string): void {
    const timer = this.debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri);
    }
  }

  /**
   * Cancel all pending compilations
   */
  cancelAll(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Hash content for caching
   */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Extract filename from URI
   */
  private getFileName(uri: string): string {
    const parts = uri.split('/');
    return parts[parts.length - 1] || 'Contract.sol';
  }

  /**
   * Get compilation statistics
   */
  getStats(): {
    cacheSize: number;
    cachedVersions: string[];
    pendingCompilations: number;
    settings: CompilerSettings;
  } {
    return {
      cacheSize: this.compilationCache.size,
      cachedVersions: SolcManager.getCachedVersions(),
      pendingCompilations: this.debounceTimers.size,
      settings: this.getSettings(),
    };
  }

  /**
   * Dispose the service
   */
  dispose(): void {
    this.cancelAll();
    this.clearCache();
    SolcManager.clearCache();
    this.removeAllListeners();
  }
}

/**
 * Global compilation service instance
 */
export const compilationService = CompilationService.getInstance();
