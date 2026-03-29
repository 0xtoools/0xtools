/**
 * Tests for Runner Backend - sigscan-runner binary discovery and compilation
 */

// Mock modules before any imports
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn().mockReturnValue(false),
    accessSync: jest.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    }),
    readFileSync: jest.fn().mockReturnValue(''),
    constants: actual.constants,
  };
});

jest.mock(
  'vscode',
  () => ({
    workspace: {
      getConfiguration: jest.fn(() => ({
        get: jest.fn(() => ''),
      })),
    },
    extensions: {
      getExtension: jest.fn(() => null),
    },
  }),
  { virtual: true }
);

import * as fs from 'fs';
import * as childProcess from 'child_process';
import { isRunnerAvailable, resetRunnerCache, compileWithRunner } from '../runner-backend';

const mockedExecFile = childProcess.execFile as unknown as jest.Mock;
const mockedExistsSync = fs.existsSync as unknown as jest.Mock;
const mockedAccessSync = fs.accessSync as unknown as jest.Mock;

describe('Runner Backend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRunnerCache();
    // Default: no binary found
    mockedExistsSync.mockReturnValue(false);
    mockedAccessSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('resetRunnerCache', () => {
    it('should reset the runner cache without throwing', () => {
      expect(() => resetRunnerCache()).not.toThrow();
    });
  });

  describe('isRunnerAvailable', () => {
    it('should return false when runner binary is not found on disk', async () => {
      const available = await isRunnerAvailable();
      expect(available).toBe(false);
    });

    it('should cache the availability result', async () => {
      const first = await isRunnerAvailable();
      const second = await isRunnerAvailable();
      expect(first).toBe(second);
    });

    it('should return true when runner binary responds to --help', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no throw = executable */
      });

      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          cb(null, 'sigscan-runner help', '');
        }
      );

      const available = await isRunnerAvailable();
      expect(available).toBe(true);
    });

    it('should return false when runner binary errors on --help', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          cb(new Error('binary not executable'), '', 'error');
        }
      );

      const available = await isRunnerAvailable();
      expect(available).toBe(false);
    });
  });

  describe('compileWithRunner', () => {
    const simpleSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    function setValue(uint256 _value) public {
        value = _value;
    }
    function getValue() public view returns (uint256) {
        return value;
    }
}
`;

    it('should throw when runner binary is not found', async () => {
      resetRunnerCache();
      await expect(compileWithRunner('/tmp/Test.sol', simpleSource)).rejects.toThrow(
        'sigscan-runner binary not found'
      );
    });

    it('should parse runner JSON output and return GasInfo', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      const runnerOutput = JSON.stringify([
        {
          contract: 'Test',
          functions: [
            {
              name: 'setValue',
              selector: '0x55241077',
              signature: 'setValue(uint256)',
              gas: 43520,
              status: 'success',
            },
            {
              name: 'getValue',
              selector: '0x20965255',
              signature: 'getValue()',
              gas: 2340,
              status: 'success',
            },
          ],
        },
      ]);

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help text', '');
          } else {
            cb(null, runnerOutput, '');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Test.sol', simpleSource);
      expect(result.success).toBe(true);
      expect(result.version).toBe('runner');
      expect(result.gasInfo.length).toBeGreaterThan(0);

      const setValueInfo = result.gasInfo.find((g) => g.name === 'setValue');
      expect(setValueInfo).toBeDefined();
      expect(setValueInfo!.gas).toBe(43520);
      expect(setValueInfo!.selector).toBe('0x55241077');
    });

    it('should handle revert status with a warning', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      const runnerOutput = JSON.stringify([
        {
          contract: 'Test',
          functions: [
            {
              name: 'setValue',
              selector: '0x55241077',
              signature: 'setValue(uint256)',
              gas: 21000,
              status: 'revert',
            },
          ],
        },
      ]);

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(null, runnerOutput, '');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Test.sol', simpleSource);
      const setValueInfo = result.gasInfo.find((g) => g.name === 'setValue');
      expect(setValueInfo).toBeDefined();
      expect(setValueInfo!.warnings.length).toBeGreaterThan(0);
      expect(setValueInfo!.warnings[0]).toContain('specific arguments');
    });

    it('should handle halt status with infinite gas', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      const runnerOutput = JSON.stringify([
        {
          contract: 'Test',
          functions: [
            {
              name: 'infiniteLoop',
              selector: '0x12345678',
              signature: 'infiniteLoop()',
              gas: 999999999,
              status: 'halt',
            },
          ],
        },
      ]);

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(null, runnerOutput, '');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Test.sol', simpleSource);
      const infiniteInfo = result.gasInfo.find((g) => g.name === 'infiniteLoop');
      expect(infiniteInfo).toBeDefined();
      expect(infiniteInfo!.gas).toBe('infinite');
    });

    it('should produce fallback result on runner failure', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(new Error('compilation failed'), '', 'error output');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Test.sol', simpleSource);
      expect(result.success).toBe(false);
      expect(result.version).toContain('fallback');
      // Fallback should still extract selectors via regex
      expect(result.gasInfo.length).toBeGreaterThan(0);
    });

    it('should extract event metadata from source', async () => {
      const sourceWithEvents = `
pragma solidity ^0.8.0;
contract Token {
    event Transfer(address indexed from, address indexed to, uint256 value);
    function transfer(address to, uint256 amount) public {
        // transfer logic
    }
}
`;
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      const runnerOutput = JSON.stringify([
        {
          contract: 'Token',
          functions: [
            {
              name: 'transfer',
              selector: '0xa9059cbb',
              signature: 'transfer(address,uint256)',
              gas: 50000,
              status: 'success',
            },
          ],
        },
      ]);

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(null, runnerOutput, '');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Token.sol', sourceWithEvents);
      const eventEntry = result.gasInfo.find((g) => g.visibility === 'event');
      expect(eventEntry).toBeDefined();
      expect(eventEntry!.name).toBe('Transfer');
      expect(eventEntry!.gas).toBe(0);
    });

    it('should handle empty source gracefully', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(new Error('no contracts'), '', 'no contracts found');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Empty.sol', '');
      expect(result.success).toBe(false);
      expect(result.gasInfo).toBeDefined();
    });

    it('should include warnings from stderr', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedAccessSync.mockImplementation(() => {
        /* no-op */
      });

      const runnerOutput = JSON.stringify([{ contract: 'Test', functions: [] }]);

      mockedExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (...args: any[]) => any) => {
          if (args && args[0] === '--help') {
            cb(null, 'help', '');
          } else {
            cb(null, runnerOutput, 'Warning: unused variable');
          }
        }
      );

      resetRunnerCache();
      await isRunnerAvailable();

      const result = await compileWithRunner('/tmp/Test.sol', simpleSource);
      expect(result.warnings).toContain('Warning: unused variable');
    });
  });
});
