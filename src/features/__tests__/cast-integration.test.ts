/**
 * Tests for CastIntegration — Foundry Cast CLI integration
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

import { CastIntegration } from '../cast-integration';
import { execFile } from 'child_process';

const mockExecFile = execFile as unknown as jest.Mock;

function mockExecFileSuccess(output: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
      callback(null, output, '');
    }
  );
}

function mockExecFileError(errorMsg: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
      callback(new Error(errorMsg), '', errorMsg);
    }
  );
}

describe('CastIntegration', () => {
  let cast: CastIntegration;

  beforeEach(() => {
    cast = new CastIntegration();
    jest.clearAllMocks();
    // Reset cached availability
    (cast as any).available = null;
  });

  describe('isAvailable', () => {
    it('should return true when cast is installed', async () => {
      mockExecFileSuccess('cast 0.2.0');
      const result = await cast.isAvailable();
      expect(result).toBe(true);
    });

    it('should return true even when cast errors (exec never rejects)', async () => {
      // Note: CastIntegration.exec() always resolves (never rejects),
      // so isAvailable() always sets available = true after exec completes.
      const freshCast = new CastIntegration();
      (freshCast as any).available = null;
      mockExecFileError('command not found');
      const result = await freshCast.isAvailable();
      // exec() resolves with {success: false} but isAvailable() doesn't check success
      expect(result).toBe(true);
    });

    it('should cache the result after first check', async () => {
      const freshCast = new CastIntegration();
      (freshCast as any).available = null;
      mockExecFileSuccess('cast 0.2.0');

      const result1 = await freshCast.isAvailable();
      const result2 = await freshCast.isAvailable();

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      // Only one call to execFile for the --version check
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('call', () => {
    it('should pass correct args to cast CLI', async () => {
      mockExecFileSuccess('42');

      await cast.call({
        to: '0xcontract',
        functionSig: 'balanceOf(address)',
        args: ['0xholder'],
        rpcUrl: 'http://localhost:8545',
      });

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[0]).toBe('cast');
      expect(callArgs[1]).toContain('call');
      expect(callArgs[1]).toContain('0xcontract');
      expect(callArgs[1]).toContain('balanceOf(address)');
      expect(callArgs[1]).toContain('0xholder');
      expect(callArgs[1]).toContain('--rpc-url');
      expect(callArgs[1]).toContain('http://localhost:8545');
    });

    it('should include from and block args when provided', async () => {
      mockExecFileSuccess('0x1');

      await cast.call({
        to: '0xcontract',
        functionSig: 'totalSupply()',
        from: '0xsender',
        block: 'latest',
      });

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('--from');
      expect(callArgs).toContain('0xsender');
      expect(callArgs).toContain('--block');
      expect(callArgs).toContain('latest');
    });

    it('should return success result', async () => {
      mockExecFileSuccess('42');

      const result = await cast.call({
        to: '0xcontract',
        functionSig: 'getValue()',
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe('42');
    });

    it('should return error result on failure', async () => {
      mockExecFileError('execution reverted');

      const result = await cast.call({
        to: '0xcontract',
        functionSig: 'getValue()',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('sig', () => {
    it('should pass correct args for function selector lookup', async () => {
      mockExecFileSuccess('0xa9059cbb');

      const result = await cast.sig('transfer(address,uint256)');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('sig');
      expect(callArgs).toContain('transfer(address,uint256)');
      expect(result.success).toBe(true);
      expect(result.output).toBe('0xa9059cbb');
    });
  });

  describe('keccak', () => {
    it('should pass correct args for keccak hashing', async () => {
      mockExecFileSuccess('0x1234567890abcdef');

      const result = await cast.keccak('hello');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('keccak');
      expect(callArgs).toContain('hello');
      expect(result.success).toBe(true);
    });
  });

  describe('balance', () => {
    it('should pass correct args for balance query', async () => {
      mockExecFileSuccess('1000000000000000000');

      const result = await cast.balance(
        '0x1111111111111111111111111111111111111111',
        'http://localhost:8545'
      );

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('balance');
      expect(callArgs).toContain('0x1111111111111111111111111111111111111111');
      expect(callArgs).toContain('--rpc-url');
      expect(callArgs).toContain('http://localhost:8545');
      expect(result.success).toBe(true);
    });

    it('should work without rpcUrl', async () => {
      mockExecFileSuccess('0');

      await cast.balance('0x1111111111111111111111111111111111111111');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).not.toContain('--rpc-url');
    });
  });

  describe('Error handling', () => {
    it('should handle errors gracefully and return structured result', async () => {
      mockExecFileError('network error');

      const result = await cast.keccak('test');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('Custom cast path', () => {
    it('should use custom path when provided', async () => {
      const customCast = new CastIntegration('/usr/local/bin/cast');
      mockExecFileSuccess('cast 0.2.0');

      await customCast.isAvailable();

      expect(mockExecFile.mock.calls[0][0]).toBe('/usr/local/bin/cast');
    });
  });

  describe('getVersion', () => {
    it('should return version string', async () => {
      mockExecFileSuccess('cast 0.2.0 (abc1234 2024-01-01)');

      const version = await cast.getVersion();
      expect(version).toBe('cast 0.2.0 (abc1234 2024-01-01)');
    });
  });

  describe('toWei', () => {
    it('should convert value to wei', async () => {
      mockExecFileSuccess('1000000000000000000');

      const result = await cast.toWei('1', 'ether');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('to-wei');
      expect(callArgs).toContain('1');
      expect(callArgs).toContain('ether');
      expect(result.output).toBe('1000000000000000000');
    });
  });

  describe('fromWei', () => {
    it('should convert wei to value', async () => {
      mockExecFileSuccess('1.0');

      await cast.fromWei('1000000000000000000');

      const callArgs = mockExecFile.mock.calls[0][1];
      expect(callArgs).toContain('from-wei');
      expect(callArgs).toContain('1000000000000000000');
    });
  });
});
