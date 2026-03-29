interface SignatureData {
  functions: unknown[];
  events: unknown[];
  errors: unknown[];
}

interface CacheMetadata {
  size: number;
  complexity: number;
  gasEstimate?: number;
}

/**
 * Cache entry for parsed file
 */
interface CacheEntry {
  hash: string;
  lastModified: number;
  signatures: SignatureData;
  metadata?: CacheMetadata;
}

/**
 * Signature cache for performance optimization
 */
export class SignatureCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize = 100;
  private ttlMs = 10 * 60 * 1000; // 10 minute TTL
  private hits = 0;
  private misses = 0;

  /**
   * Get cached signatures for a file
   */
  public get(filePath: string, fileContent: string): CacheEntry | null {
    const entry = this.cache.get(filePath);
    if (!entry) {
      this.misses++;
      return null;
    }

    // TTL check
    if (Date.now() - entry.lastModified > this.ttlMs) {
      this.cache.delete(filePath);
      this.misses++;
      return null;
    }

    const currentHash = this.calculateHash(fileContent);
    if (entry.hash !== currentHash) {
      // File changed, invalidate cache
      this.cache.delete(filePath);
      this.misses++;
      return null;
    }

    // Move to end for LRU behavior (Map preserves insertion order)
    this.cache.delete(filePath);
    this.cache.set(filePath, entry);

    this.hits++;
    return entry;
  }

  /**
   * Store signatures in cache
   */
  public set(
    filePath: string,
    fileContent: string,
    signatures: SignatureData,
    metadata?: CacheMetadata
  ): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry (LRU)
      const firstKey = this.cache.keys().next().value as string | undefined;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    const entry: CacheEntry = {
      hash: this.calculateHash(fileContent),
      lastModified: Date.now(),
      signatures,
      metadata,
    };

    this.cache.set(filePath, entry);
  }

  /**
   * Invalidate cache for a file
   */
  public invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /**
   * Clear entire cache
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getStats(): { size: number; maxSize: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Calculate hash of content (DJB2 — fast inline hash for cache invalidation)
   */
  private calculateHash(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }
}

// Singleton instance
export const signatureCache = new SignatureCache();
