/**
 * Tests for SnippetProvider — Solidity code snippet provider
 */

// Reset singleton state between tests
beforeEach(() => {
  // Access module internals to reset singleton
  jest.resetModules();
});

describe('SnippetProvider', () => {
  // We need fresh imports for each test to handle singleton correctly
  function getProvider() {
    // Clear singleton by resetting module-level state
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../snippet-provider');
    return new mod.SnippetProvider();
  }

  describe('getAll', () => {
    it('should return all snippets', () => {
      const provider = getProvider();
      const all = provider.getAll();
      expect(all).toBeDefined();
      expect(all.length).toBeGreaterThan(0);
    });

    it('should return frozen array', () => {
      const provider = getProvider();
      const all = provider.getAll();
      expect(Object.isFrozen(all)).toBe(true);
    });
  });

  describe('getCategories', () => {
    it('should return all categories', () => {
      const provider = getProvider();
      const categories = provider.getCategories();
      expect(categories).toBeDefined();
      expect(categories.length).toBeGreaterThan(0);
    });

    it('should include expected categories', () => {
      const provider = getProvider();
      const categories = provider.getCategories();
      expect(categories).toContain('Token Standards');
      expect(categories).toContain('Access Control');
      expect(categories).toContain('Security Patterns');
      expect(categories).toContain('Common Patterns');
      expect(categories).toContain('Gas Optimization');
    });

    it('should not contain duplicates', () => {
      const provider = getProvider();
      const categories = provider.getCategories();
      const unique = [...new Set(categories)];
      expect(categories.length).toBe(unique.length);
    });
  });

  describe('getByCategory', () => {
    it('should filter snippets by category', () => {
      const provider = getProvider();
      const tokenSnippets = provider.getByCategory('Token Standards');
      expect(tokenSnippets.length).toBeGreaterThan(0);
      tokenSnippets.forEach((s: any) => {
        expect(s.category).toBe('Token Standards');
      });
    });

    it('should be case-insensitive', () => {
      const provider = getProvider();
      const upper = provider.getByCategory('TOKEN STANDARDS');
      const lower = provider.getByCategory('token standards');
      expect(upper.length).toBe(lower.length);
      expect(upper.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown category', () => {
      const provider = getProvider();
      const result = provider.getByCategory('NonExistent Category');
      expect(result).toEqual([]);
    });
  });

  describe('search', () => {
    it('should find snippets by prefix', () => {
      const provider = getProvider();
      const results = provider.search('erc20');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((s: any) => s.prefix === 'erc20')).toBe(true);
    });

    it('should find snippets by label', () => {
      const provider = getProvider();
      const results = provider.search('Ownable');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((s: any) => s.label.includes('Ownable'))).toBe(true);
    });

    it('should find snippets by description', () => {
      const provider = getProvider();
      const results = provider.search('reentrancy');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should be case-insensitive', () => {
      const provider = getProvider();
      const upper = provider.search('ERC20');
      const lower = provider.search('erc20');
      expect(upper.length).toBe(lower.length);
    });

    it('should return empty array for no matches', () => {
      const provider = getProvider();
      const results = provider.search('xyznonexistent123');
      expect(results).toEqual([]);
    });
  });

  describe('Singleton behavior', () => {
    it('should return same instance on multiple constructions', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('../snippet-provider');
      const provider1 = new mod.SnippetProvider();
      const provider2 = new mod.SnippetProvider();
      // They should be the same instance (singleton)
      expect(provider1).toBe(provider2);
    });
  });

  describe('Snippet structure', () => {
    it('should have required fields on each snippet', () => {
      const provider = getProvider();
      const all = provider.getAll();

      for (const snippet of all) {
        expect(snippet.prefix).toBeDefined();
        expect(typeof snippet.prefix).toBe('string');
        expect(snippet.prefix.length).toBeGreaterThan(0);

        expect(snippet.label).toBeDefined();
        expect(typeof snippet.label).toBe('string');
        expect(snippet.label.length).toBeGreaterThan(0);

        expect(snippet.body).toBeDefined();
        expect(typeof snippet.body).toBe('string');
        expect(snippet.body.length).toBeGreaterThan(0);

        expect(snippet.category).toBeDefined();
        expect(typeof snippet.category).toBe('string');
        expect(snippet.category.length).toBeGreaterThan(0);

        expect(snippet.description).toBeDefined();
        expect(typeof snippet.description).toBe('string');
        expect(snippet.description.length).toBeGreaterThan(0);
      }
    });

    it('should have unique prefixes', () => {
      const provider = getProvider();
      const all = provider.getAll();
      const prefixes = all.map((s: any) => s.prefix);
      const unique = [...new Set(prefixes)];
      expect(prefixes.length).toBe(unique.length);
    });
  });
});
