/**
 * Tests for ForgeScriptRunner — Forge Script Runner
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}));

import { ForgeScriptRunner, ScriptConfig, ScriptResult } from '../forge-script-runner';
import { execFile } from 'child_process';
import * as fs from 'fs';

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockReaddirSync = fs.readdirSync as jest.Mock;

describe('ForgeScriptRunner', () => {
  let runner: ForgeScriptRunner;

  beforeEach(() => {
    runner = new ForgeScriptRunner();
    jest.clearAllMocks();
    // Reset cached availability
    (runner as any)._available = null;
  });

  describe('Constructor', () => {
    it('should create runner', () => {
      expect(runner).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('should return true when forge is installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'forge 0.2.0', '');
        }
      );

      const result = await runner.isAvailable();
      expect(result).toBe(true);
    });

    it('should return false when forge is not installed', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('not found'), '', '');
        }
      );

      const result = await runner.isAvailable();
      expect(result).toBe(false);
    });

    it('should cache the result after first check', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'forge 0.2.0', '');
        }
      );

      await runner.isAvailable();
      await runner.isAvailable();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('discoverScripts', () => {
    it('should find .s.sol files in script directory', async () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/script') || p.endsWith('.s.sol');
      });

      mockReaddirSync.mockImplementation((dir: string, _opts: any) => {
        if (dir.endsWith('/script')) {
          return [
            { name: 'Deploy.s.sol', isDirectory: () => false, isFile: () => true },
            { name: 'Setup.s.sol', isDirectory: () => false, isFile: () => true },
            { name: 'Regular.sol', isDirectory: () => false, isFile: () => true },
          ];
        }
        return [];
      });

      const scripts = await runner.discoverScripts('/project');

      expect(scripts.length).toBe(2);
      expect(scripts[0]).toContain('Deploy.s.sol');
      expect(scripts[1]).toContain('Setup.s.sol');
    });

    it('should return empty array when script directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const scripts = await runner.discoverScripts('/project');
      expect(scripts).toEqual([]);
    });
  });

  describe('run', () => {
    it('should pass correct args to forge script', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'Script ran successfully', '');
        }
      );

      const config: ScriptConfig = {
        scriptPath: '/project/script/Deploy.s.sol',
        rpcUrl: 'http://localhost:8545',
        broadcast: false,
        verbosity: 3,
      };

      const result = await runner.run(config);

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[0]).toBe('forge');
      expect(callArgs[1]).toContain('script');
      expect(callArgs[1]).toContain('/project/script/Deploy.s.sol');
      expect(callArgs[1]).toContain('--rpc-url');
      expect(callArgs[1]).toContain('http://localhost:8545');
      expect(callArgs[1]).toContain('-vvv');
      expect(result.success).toBe(true);
    });

    it('should include broadcast flag when specified', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '', '');
        }
      );

      await runner.run({
        scriptPath: '/project/script/Deploy.s.sol',
        broadcast: true,
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--broadcast');
    });

    it('should handle script failure', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('compilation failed'), '', 'Error: compilation failed');
        }
      );

      const result = await runner.run({
        scriptPath: '/project/script/Deploy.s.sol',
      });

      expect(result.success).toBe(false);
      expect(result.stderr).toContain('compilation failed');
    });

    it('should include private key when provided', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '', '');
        }
      );

      await runner.run({
        scriptPath: '/project/script/Deploy.s.sol',
        privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--private-key');
    });

    it('should parse gas used from output', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, 'Gas used: 123456\nTotal gas used: 200000', '');
        }
      );

      const result = await runner.run({
        scriptPath: '/project/script/Deploy.s.sol',
      });

      expect(result.gasUsed).toBeDefined();
      expect(result.gasUsed).toBe(200000);
    });
  });

  describe('generateReport', () => {
    it('should produce markdown report', () => {
      const result: ScriptResult = {
        success: true,
        output: 'Script ran successfully',
        stderr: '',
        transactions: [
          {
            type: 'create',
            contractName: 'MyContract',
            contractAddress: '0x1234',
            gas: 500000,
          },
        ],
        gasUsed: 500000,
      };

      const config: ScriptConfig = {
        scriptPath: '/project/script/Deploy.s.sol',
        broadcast: false,
      };

      const report = runner.generateReport(result, config);

      expect(report).toContain('## Forge Script Report');
      expect(report).toContain('Deploy.s.sol');
      expect(report).toContain('Success');
      expect(report).toContain('Simulation');
      expect(report).toContain('### Transactions');
      expect(report).toContain('MyContract');
    });

    it('should show errors when script fails', () => {
      const result: ScriptResult = {
        success: false,
        output: '',
        stderr: 'Compilation failed: syntax error',
      };

      const config: ScriptConfig = {
        scriptPath: '/project/script/Deploy.s.sol',
        broadcast: false,
      };

      const report = runner.generateReport(result, config);
      expect(report).toContain('Failed');
      expect(report).toContain('### Errors');
      expect(report).toContain('syntax error');
    });
  });

  describe('parseBroadcastLog', () => {
    it('should parse broadcast log JSON', () => {
      const mockReadFileSync = fs.readFileSync as jest.Mock;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          transactions: [
            {
              hash: '0xabc',
              contractName: 'MyContract',
              contractAddress: '0x1234',
              transactionType: 'CREATE',
            },
          ],
        })
      );

      const results = runner.parseBroadcastLog('/project/broadcast/Deploy.s.sol/1/run-latest.json');

      expect(results.length).toBe(1);
      expect(results[0].hash).toBe('0xabc');
      expect(results[0].contractName).toBe('MyContract');
      expect(results[0].type).toBe('CREATE');
    });

    it('should return empty array when file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const results = runner.parseBroadcastLog('/nonexistent');
      expect(results).toEqual([]);
    });
  });
});
