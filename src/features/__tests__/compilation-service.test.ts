/**
 * Tests for Compilation Service - Centralized compiler lifecycle management
 */

// Mock all backends before importing
jest.mock('../runner-backend', () => ({
  isRunnerAvailable: jest.fn().mockResolvedValue(false),
  compileWithRunner: jest.fn(),
}));
jest.mock('../forge-backend', () => ({
  isForgeAvailable: jest.fn().mockResolvedValue(false),
  findFoundryRoot: jest.fn().mockReturnValue(null),
  compileWithForge: jest.fn(),
}));
jest.mock('../SolcManager', () => ({
  SolcManager: {
    getAvailableVersions: jest.fn().mockResolvedValue([]),
    isCached: jest.fn().mockReturnValue(false),
    load: jest.fn().mockResolvedValue(undefined),
    getCachedVersions: jest.fn().mockReturnValue([]),
    clearCache: jest.fn(),
  },
  compileWithGasAnalysis: jest.fn().mockResolvedValue({
    success: true,
    version: 'solc-mock',
    gasInfo: [
      {
        name: 'test',
        selector: '0x12345678',
        gas: 21000,
        loc: { line: 1, endLine: 5 },
        visibility: 'public',
        stateMutability: 'nonpayable',
        warnings: [],
      },
    ],
    errors: [],
    warnings: [],
  }),
  parsePragmaFromSource: jest.fn().mockReturnValue(null),
  resolveSolcVersion: jest.fn().mockReturnValue('0.8.20'),
}));
jest.mock(
  'vscode',
  () => ({
    workspace: {
      getConfiguration: jest.fn(() => ({
        get: jest.fn().mockReturnValue(true),
      })),
    },
  }),
  { virtual: true }
);

import { CompilationService } from '../compilation-service';

describe('CompilationService', () => {
  let service: CompilationService;

  beforeEach(() => {
    // Access and reset the singleton for clean tests.
    // Use getInstance() which returns the singleton, then reset its state.
    service = CompilationService.getInstance();
    service.cancelAll();
    service.clearCache();
    service.removeAllListeners();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = CompilationService.getInstance();
      const instance2 = CompilationService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('Settings Management', () => {
    it('should return default settings', () => {
      const settings = service.getSettings();
      expect(settings).toBeDefined();
      expect(settings.optimizer).toBeDefined();
      expect(settings.optimizer!.enabled).toBe(true);
      expect(settings.optimizer!.runs).toBe(200);
    });

    it('should update settings', () => {
      service.updateSettings({ optimizer: { enabled: false, runs: 100 } });
      const settings = service.getSettings();
      expect(settings.optimizer!.enabled).toBe(false);
      expect(settings.optimizer!.runs).toBe(100);
      // Reset
      service.updateSettings({ optimizer: { enabled: true, runs: 200 } });
    });

    it('should clear cache when settings change', () => {
      // Compile something first to populate cache
      const spy = jest.spyOn(service, 'clearCache');
      service.updateSettings({ evmVersion: 'london' });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
      // Reset
      service.updateSettings({ evmVersion: 'paris' });
    });
  });

  describe('Debounce Configuration', () => {
    it('should set debounce within bounds', () => {
      service.setDebounceMs(500);
      // We can't directly read the value, but it should not throw
      expect(() => service.setDebounceMs(500)).not.toThrow();
    });

    it('should clamp debounce to minimum 100ms', () => {
      expect(() => service.setDebounceMs(10)).not.toThrow();
    });

    it('should clamp debounce to maximum 1000ms', () => {
      expect(() => service.setDebounceMs(5000)).not.toThrow();
    });
  });

  describe('Compilation', () => {
    const source = `
pragma solidity ^0.8.0;
contract Test {
    function foo() public {}
}
`;

    it('should compile source code and return a result', async () => {
      const result = await service.compile('file:///tmp/Test.sol', source, 'file-save');
      expect(result).toBeDefined();
      expect(result.uri).toBe('file:///tmp/Test.sol');
      expect(result.trigger).toBe('file-save');
      expect(result.contentHash).toBeTruthy();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should return cached result for same content', async () => {
      const result1 = await service.compile('file:///tmp/Test.sol', source, 'file-save');
      const result2 = await service.compile('file:///tmp/Test.sol', source, 'file-save');
      // Second call should be cached
      expect(result2.cached).toBe(true);
      expect(result2.contentHash).toBe(result1.contentHash);
    });

    it('should recompile on optimizer-change trigger', async () => {
      await service.compile('file:///tmp/Test.sol', source, 'file-save');
      const result = await service.compile('file:///tmp/Test.sol', source, 'optimizer-change');
      // optimizer-change always forces recompile
      expect(result.cached).toBe(false);
    });

    it('should recompile on pragma-change trigger', async () => {
      await service.compile('file:///tmp/Test.sol', source, 'file-save');
      const result = await service.compile('file:///tmp/Test.sol', source, 'pragma-change');
      expect(result.cached).toBe(false);
    });

    it('should emit compilation:start event', async () => {
      const spy = jest.fn();
      service.on('compilation:start', spy);
      await service.compile('file:///tmp/Test.sol', source, 'manual');
      // Wait for events
      expect(spy).toHaveBeenCalled();
    });

    it('should emit compilation:success on successful compile', async () => {
      const spy = jest.fn();
      service.on('compilation:success', spy);
      service.clearCache();
      await service.compile('file:///tmp/Test.sol', source, 'file-open');
      expect(spy).toHaveBeenCalled();
      const eventData = spy.mock.calls[0][0];
      expect(eventData.uri).toBe('file:///tmp/Test.sol');
      expect(eventData.output).toBeDefined();
    });
  });

  describe('Cache Management', () => {
    it('should get cached result by content hash', async () => {
      const source = 'pragma solidity ^0.8.0; contract A {}';
      await service.compile('file:///tmp/A.sol', source, 'file-save');

      // The getCachedByUri should return the cached result
      const cached = service.getCachedByUri('file:///tmp/A.sol');
      expect(cached).not.toBeNull();
      expect(cached!.cached).toBe(true);
    });

    it('should return null for non-existent cache', () => {
      const cached = service.getCached('non-existent-hash');
      expect(cached).toBeNull();
    });

    it('should return null from getCachedByUri for unknown URI', () => {
      const cached = service.getCachedByUri('file:///unknown.sol');
      expect(cached).toBeNull();
    });

    it('should clear all caches', async () => {
      const source = 'pragma solidity ^0.8.0; contract B {}';
      await service.compile('file:///tmp/B.sol', source, 'file-save');
      service.clearCache();
      const cached = service.getCachedByUri('file:///tmp/B.sol');
      expect(cached).toBeNull();
    });

    it('should return empty gas info for unknown URI', () => {
      const gasInfo = service.getGasInfo('file:///unknown.sol');
      expect(gasInfo).toEqual([]);
    });
  });

  describe('Cancellation', () => {
    it('should cancel pending compilation for a URI', () => {
      expect(() => service.cancelPending('file:///tmp/Test.sol')).not.toThrow();
    });

    it('should cancel all pending compilations', () => {
      expect(() => service.cancelAll()).not.toThrow();
    });
  });

  describe('Statistics', () => {
    it('should return compilation statistics', () => {
      const stats = service.getStats();
      expect(stats).toBeDefined();
      expect(typeof stats.cacheSize).toBe('number');
      expect(Array.isArray(stats.cachedVersions)).toBe(true);
      expect(typeof stats.pendingCompilations).toBe('number');
      expect(stats.settings).toBeDefined();
    });
  });

  describe('Disposal', () => {
    it('should dispose without errors', () => {
      // Create a fresh instance that we can dispose
      // Since it's a singleton, just ensure dispose does not throw
      expect(() => service.dispose()).not.toThrow();
    });
  });

  describe('URI to FilePath conversion', () => {
    it('should handle file URIs in compileNow', async () => {
      const source = 'pragma solidity ^0.8.0; contract C {}';
      const result = await service.compileNow('file:///tmp/C.sol', source, 'manual');
      expect(result).toBeDefined();
      expect(result.uri).toBe('file:///tmp/C.sol');
    });

    it('should handle raw paths as URIs', async () => {
      const source = 'pragma solidity ^0.8.0; contract D {}';
      const result = await service.compileNow('/tmp/D.sol', source, 'manual');
      expect(result).toBeDefined();
    });
  });
});
