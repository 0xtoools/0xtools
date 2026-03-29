/**
 * Tests for ForkSimulator — Chain fork testing via Anvil
 */

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  execFile: jest.fn(),
}));

jest.mock('http', () => ({
  request: jest.fn(),
}));

import { ForkSimulator, ForkConfig, SimulationResult } from '../fork-simulator';
import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as jest.Mock;

describe('ForkSimulator', () => {
  let simulator: ForkSimulator;

  beforeEach(() => {
    simulator = new ForkSimulator();
    jest.clearAllMocks();
    // Reset cached availability
    (simulator as any)._available = null;
  });

  describe('Constructor', () => {
    it('should create simulator with default state', () => {
      expect(simulator).toBeDefined();
      expect(simulator.isRunning()).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('should return true when anvil is installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'anvil 0.2.0', '');
        }
      );

      const result = await simulator.isAvailable();
      expect(result).toBe(true);
    });

    it('should return false when anvil is not installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('not found'), '', '');
        }
      );

      const result = await simulator.isAvailable();
      expect(result).toBe(false);
    });

    it('should cache the result after first check', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'anvil 0.2.0', '');
        }
      );

      await simulator.isAvailable();
      await simulator.isAvailable();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      expect(simulator.isRunning()).toBe(false);
    });
  });

  describe('simulate (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(
        simulator.simulate({
          to: '0xcontract',
          data: '0x12345678',
        })
      ).rejects.toThrow('not running');
    });
  });

  describe('impersonate (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(
        simulator.impersonate('0x1111111111111111111111111111111111111111')
      ).rejects.toThrow('not running');
    });
  });

  describe('setStorage (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(simulator.setStorage('0xaddr', '0x0', '0x1')).rejects.toThrow('not running');
    });
  });

  describe('getBlockNumber (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(simulator.getBlockNumber()).rejects.toThrow('not running');
    });
  });

  describe('mineBlocks (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(simulator.mineBlocks(10)).rejects.toThrow('not running');
    });
  });

  describe('warpTime (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(simulator.warpTime(3600)).rejects.toThrow('not running');
    });
  });

  describe('snapshot (when not running)', () => {
    it('should throw when fork is not running', async () => {
      await expect(simulator.snapshot()).rejects.toThrow('not running');
    });
  });

  describe('stopFork', () => {
    it('should handle stopFork when not running', async () => {
      await expect(simulator.stopFork()).resolves.toBeUndefined();
      expect(simulator.isRunning()).toBe(false);
    });
  });

  describe('generateReport', () => {
    it('should produce markdown report from simulation results', () => {
      const results: SimulationResult[] = [
        {
          success: true,
          gasUsed: 50000,
          returnData: '0x0000000000000000000000000000000000000000000000000000000000000001',
          logs: [],
        },
        {
          success: false,
          gasUsed: 21000,
          returnData: '0x',
          logs: [],
          error: 'execution reverted',
        },
      ];

      const config: ForkConfig = {
        chain: 'ethereum',
        rpcUrl: 'https://eth.llamarpc.com',
        blockNumber: 18000000,
      };

      const report = simulator.generateReport(results, config);

      expect(report).toContain('# Fork Simulation Report');
      expect(report).toContain('## Configuration');
      expect(report).toContain('ethereum');
      expect(report).toContain('18000000');
      expect(report).toContain('## Results');
      expect(report).toContain('[OK]');
      expect(report).toContain('[FAIL]');
      expect(report).toContain('execution reverted');
      expect(report).toContain('## Summary');
      expect(report).toContain('Total Transactions');
      expect(report).toContain('Successful | 1');
      expect(report).toContain('Failed | 1');
    });

    it('should handle empty results', () => {
      const config: ForkConfig = {
        chain: 'polygon',
      };

      const report = simulator.generateReport([], config);
      expect(report).toContain('# Fork Simulation Report');
      expect(report).toContain('polygon');
      expect(report).toContain('Total Transactions | 0');
    });

    it('should include log info when present', () => {
      const results: SimulationResult[] = [
        {
          success: true,
          gasUsed: 80000,
          returnData: '0x',
          logs: [
            {
              address: '0x1234567890abcdef1234567890abcdef12345678',
              topics: ['0xddf252ad', '0x0000', '0x1111'],
              data: '0x',
            },
          ],
        },
      ];

      const report = simulator.generateReport(results, { chain: 'ethereum' });
      expect(report).toContain('Events');
      expect(report).toContain('topics');
    });
  });

  describe('startFork config translation', () => {
    it('should throw for unknown chain without rpcUrl', async () => {
      await expect(simulator.startFork({ chain: 'nonexistent-chain-xyz' })).rejects.toThrow(
        'No RPC URL'
      );
    });
  });
});
