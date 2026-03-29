/**
 * Tests for AnvilManager — Local Anvil Node Manager
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('http', () => ({
  request: jest.fn(),
}));

import { AnvilManager } from '../anvil-manager';
import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as jest.Mock;

describe('AnvilManager', () => {
  let manager: AnvilManager;

  beforeEach(() => {
    manager = new AnvilManager();
    jest.clearAllMocks();
    // Reset cached availability
    (manager as any)._available = null;
  });

  describe('Constructor', () => {
    it('should create manager with default state', () => {
      expect(manager).toBeDefined();
      expect(manager.isRunning()).toBe(false);
      expect(manager.getAccounts()).toEqual([]);
    });
  });

  describe('isAvailable', () => {
    it('should return true when anvil is installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'anvil 0.2.0', '');
        }
      );

      const result = await manager.isAvailable();
      expect(result).toBe(true);
    });

    it('should return false when anvil is not installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('command not found'), '', '');
        }
      );

      const result = await manager.isAvailable();
      expect(result).toBe(false);
    });

    it('should cache the result after first check', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'anvil 0.2.0', '');
        }
      );

      await manager.isAvailable();
      await manager.isAvailable();

      // Only one execFile call
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      expect(manager.isRunning()).toBe(false);
    });

    it('should return false after construction', () => {
      const freshManager = new AnvilManager();
      expect(freshManager.isRunning()).toBe(false);
    });
  });

  describe('getAccounts', () => {
    it('should return empty array when not running', () => {
      const accounts = manager.getAccounts();
      expect(accounts).toEqual([]);
    });

    it('should return a copy of accounts array', () => {
      const accounts1 = manager.getAccounts();
      const accounts2 = manager.getAccounts();
      expect(accounts1).toEqual(accounts2);
      expect(accounts1).not.toBe(accounts2);
    });
  });

  describe('getRpcUrl', () => {
    it('should return correct default URL', () => {
      const url = manager.getRpcUrl();
      expect(url).toBe('http://127.0.0.1:8545');
    });
  });

  describe('getState', () => {
    it('should return null when not running', () => {
      const state = manager.getState();
      expect(state).toBeNull();
    });
  });

  describe('generateReport', () => {
    it('should produce not running report when stopped', () => {
      const report = manager.generateReport();
      expect(report).toContain('Not running');
    });

    it('should contain anvil status heading', () => {
      const report = manager.generateReport();
      expect(report).toContain('Anvil');
    });
  });

  describe('stop', () => {
    it('should handle stop when not running', async () => {
      // Should not throw
      await expect(manager.stop()).resolves.toBeUndefined();
    });
  });

  describe('getOutput', () => {
    it('should return empty string initially', () => {
      expect(manager.getOutput()).toBe('');
    });
  });

  describe('mine (when not running)', () => {
    it('should reject when not running', async () => {
      await expect(manager.mine(1)).rejects.toThrow('not running');
    });
  });

  describe('snapshot (when not running)', () => {
    it('should reject when not running', async () => {
      await expect(manager.snapshot()).rejects.toThrow('not running');
    });
  });

  describe('impersonate (when not running)', () => {
    it('should reject when not running', async () => {
      await expect(
        manager.impersonate('0x1111111111111111111111111111111111111111')
      ).rejects.toThrow('not running');
    });
  });

  describe('setBalance (when not running)', () => {
    it('should reject when not running', async () => {
      await expect(
        manager.setBalance('0x1111111111111111111111111111111111111111', '0x1')
      ).rejects.toThrow('not running');
    });
  });
});
