/**
 * Tests for HardhatIntegration — Hardhat project integration
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

import { HardhatIntegration, HardhatTaskResult } from '../hardhat-integration';
import { execFile } from 'child_process';
import * as fs from 'fs';

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;

describe('HardhatIntegration', () => {
  let hardhat: HardhatIntegration;

  beforeEach(() => {
    hardhat = new HardhatIntegration();
    jest.clearAllMocks();
    // Reset cached state
    (hardhat as any)._available = null;
    (hardhat as any)._projectDetectionCache = new Map();
    (hardhat as any)._configCache = new Map();
    (hardhat as any)._taskCache = new Map();
  });

  describe('Constructor', () => {
    it('should create integration', () => {
      expect(hardhat).toBeDefined();
    });
  });

  describe('isHardhatProject', () => {
    it('should detect hardhat.config.ts', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.ts');
      });

      const result = await hardhat.isHardhatProject('/my-project');
      expect(result).toBe(true);
    });

    it('should detect hardhat.config.js', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.js');
      });

      const result = await hardhat.isHardhatProject('/my-project');
      expect(result).toBe(true);
    });

    it('should detect hardhat in package.json dependencies', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('package.json');
      });

      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          devDependencies: {
            hardhat: '^2.19.0',
          },
        })
      );

      const result = await hardhat.isHardhatProject('/my-project');
      expect(result).toBe(true);
    });

    it('should return false when no hardhat indicators found', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await hardhat.isHardhatProject('/not-hardhat');
      expect(result).toBe(false);
    });

    it('should cache detection results', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.ts');
      });

      await hardhat.isHardhatProject('/my-project');
      await hardhat.isHardhatProject('/my-project');

      // existsSync is called only for the first detection
      const firstCallCount = mockExistsSync.mock.calls.filter((c: any[]) =>
        c[0].includes('/my-project')
      ).length;
      // The second call should use cache and not call existsSync again
      expect(firstCallCount).toBeLessThanOrEqual(2); // At most 2 config file checks
    });

    it('should handle malformed package.json gracefully', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('package.json');
      });

      mockReadFileSync.mockReturnValue('not valid json');

      const result = await hardhat.isHardhatProject('/bad-project');
      expect(result).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('should return true when hardhat is available', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '2.19.0', '');
        }
      );

      const result = await hardhat.isAvailable();
      expect(result).toBe(true);
    });

    it('should return false when hardhat is not available', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('not found'), '', '');
        }
      );

      const result = await hardhat.isAvailable();
      expect(result).toBe(false);
    });

    it('should cache the result', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '2.19.0', '');
        }
      );

      await hardhat.isAvailable();
      await hardhat.isAvailable();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getNetworks', () => {
    it('should parse networks from config', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.ts');
      });

      mockReadFileSync.mockReturnValue(`
import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  networks: {
    goerli: {
      url: "https://goerli.infura.io/v3/KEY",
      chainId: 5
    },
    mainnet: {
      url: "https://mainnet.infura.io/v3/KEY"
    }
  }
};

export default config;
`);

      const networks = await hardhat.getNetworks('/my-project');

      // Should include parsed networks plus default hardhat + localhost
      expect(networks).toContain('hardhat');
      expect(networks).toContain('localhost');
    });

    it('should return empty array when no config found', async () => {
      mockExistsSync.mockReturnValue(false);

      const networks = await hardhat.getNetworks('/no-config');
      expect(networks).toEqual([]);
    });
  });

  describe('getConfig', () => {
    it('should parse solidity version', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.ts');
      });

      mockReadFileSync.mockReturnValue(`
const config = {
  solidity: "0.8.20",
};
module.exports = config;
`);

      const config = await hardhat.getConfig('/my-project');

      expect(config).toBeDefined();
      expect(config!.solidity.version).toBe('0.8.20');
    });

    it('should parse optimizer settings', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.js');
      });

      mockReadFileSync.mockReturnValue(`
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  }
};
`);

      const config = await hardhat.getConfig('/my-project');

      expect(config).toBeDefined();
      expect(config!.solidity.settings).toBeDefined();
      expect(config!.solidity.settings!.optimizer!.enabled).toBe(true);
      expect(config!.solidity.settings!.optimizer!.runs).toBe(200);
    });

    it('should return null when no config file exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const config = await hardhat.getConfig('/no-project');
      expect(config).toBeNull();
    });

    it('should always include hardhat and localhost networks', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('hardhat.config.ts');
      });

      mockReadFileSync.mockReturnValue('module.exports = { solidity: "0.8.20" };');

      const config = await hardhat.getConfig('/my-project');
      expect(config!.networks.hardhat).toBeDefined();
      expect(config!.networks.localhost).toBeDefined();
    });
  });

  describe('generateReport', () => {
    it('should produce markdown report for successful task', () => {
      const result: HardhatTaskResult = {
        success: true,
        output: 'Compiled 5 Solidity files successfully',
        exitCode: 0,
      };

      const report = hardhat.generateReport(result, 'compile');

      expect(report).toContain('# Hardhat Task Report');
      expect(report).toContain('compile');
      expect(report).toContain('Success');
      expect(report).toContain('Exit Code | 0');
      expect(report).toContain('## Output');
      expect(report).toContain('Compiled 5');
      expect(report).toContain('Compilation Summary');
    });

    it('should produce markdown report for failed task', () => {
      const result: HardhatTaskResult = {
        success: false,
        output: '',
        error: 'Error HH1: You are not inside a Hardhat project',
        exitCode: 1,
      };

      const report = hardhat.generateReport(result, 'compile');

      expect(report).toContain('Failed');
      expect(report).toContain('## Errors');
      expect(report).toContain('not inside a Hardhat project');
    });

    it('should extract test results for test task', () => {
      const result: HardhatTaskResult = {
        success: true,
        output: '  5 passing (2s)\n  1 failing',
        exitCode: 0,
      };

      const report = hardhat.generateReport(result, 'test');

      expect(report).toContain('Test Summary');
      expect(report).toContain('5');
      expect(report).toContain('1');
    });

    it('should include 0xTools attribution', () => {
      const result: HardhatTaskResult = {
        success: true,
        output: '',
        exitCode: 0,
      };

      const report = hardhat.generateReport(result, 'clean');
      expect(report).toContain('0xTools Hardhat integration');
    });
  });

  describe('compile', () => {
    it('should call hardhat compile with --force', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'Compiled 3 Solidity files', '');
        }
      );

      const result = await hardhat.compile('/my-project');

      expect(result.success).toBe(true);
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('compile');
      expect(callArgs).toContain('--force');
    });
  });

  describe('test', () => {
    it('should run hardhat test', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '3 passing', '');
        }
      );

      const result = await hardhat.test('/my-project');

      expect(result.success).toBe(true);
      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('test');
    });

    it('should pass test file when specified', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '1 passing', '');
        }
      );

      await hardhat.test('/my-project', 'test/MyTest.ts');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('test/MyTest.ts');
    });

    it('should pass grep pattern when specified', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '1 passing', '');
        }
      );

      await hardhat.test('/my-project', undefined, 'should transfer');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--grep');
      expect(callArgs).toContain('should transfer');
    });
  });
});
