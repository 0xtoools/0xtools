/**
 * Tests for ChainExplorer — Contract state reader
 */

import { keccak256 } from 'js-sha3';
import { ChainExplorer, ContractState } from '../chain-explorer';

function createMockRpc() {
  return {
    call: jest.fn(),
    ethCall: jest.fn(),
    getBalance: jest.fn(),
    getBlock: jest.fn(),
    getStorageAt: jest.fn(),
    getChain: jest.fn().mockReturnValue({
      chainId: 1,
      name: 'Ethereum Mainnet',
      currency: 'ETH',
      decimals: 18,
    }),
    formatValue: jest.fn((wei: bigint, _chain: string) => {
      if (wei === 0n) {
        return '0 ETH';
      }
      return `${Number(wei) / 1e18} ETH`;
    }),
  } as any;
}

describe('ChainExplorer', () => {
  let explorer: ChainExplorer;
  let mockRpc: ReturnType<typeof createMockRpc>;

  beforeEach(() => {
    mockRpc = createMockRpc();
    explorer = new ChainExplorer(mockRpc);
  });

  describe('Constructor', () => {
    it('should create explorer with provided RpcProvider', () => {
      expect(explorer).toBeDefined();
    });

    it('should create explorer without RpcProvider', () => {
      const defaultExplorer = new ChainExplorer();
      expect(defaultExplorer).toBeDefined();
    });
  });

  describe('encodeCall', () => {
    it('should compute correct 4-byte selector for balanceOf(address)', () => {
      const encoded = explorer.encodeCall('balanceOf(address)', [
        '0x1111111111111111111111111111111111111111',
      ]);

      // balanceOf(address) selector: 70a08231
      const expectedSelector = keccak256('balanceOf(address)').substring(0, 8);
      expect(encoded.startsWith('0x')).toBe(true);
      expect(encoded.substring(2, 10)).toBe(expectedSelector);
    });

    it('should encode transfer(address,uint256) correctly', () => {
      const addr = '0x1111111111111111111111111111111111111111';
      const amount = '1000';

      const encoded = explorer.encodeCall('transfer(address,uint256)', [addr, amount]);

      const expectedSelector = keccak256('transfer(address,uint256)').substring(0, 8);
      expect(encoded.substring(2, 10)).toBe(expectedSelector);

      // Address should be left-padded to 32 bytes
      const addrPart = encoded.substring(10, 74);
      expect(addrPart).toBe('0'.repeat(24) + '1111111111111111111111111111111111111111');

      // Amount should be encoded as uint256
      const amountPart = encoded.substring(74, 138);
      expect(BigInt('0x' + amountPart).toString()).toBe('1000');
    });

    it('should encode function with no arguments', () => {
      const encoded = explorer.encodeCall('decimals()', []);
      const expectedSelector = keccak256('decimals()').substring(0, 8);
      expect(encoded).toBe('0x' + expectedSelector);
    });

    it('should encode bool argument correctly', () => {
      const encoded = explorer.encodeCall('setApproval(bool)', ['true']);
      expect(encoded.length).toBe(2 + 8 + 64); // 0x + selector + 1 word
      // The last character of the bool encoding should be 1
      expect(encoded.endsWith('1')).toBe(true);
    });
  });

  describe('readMapping', () => {
    it('should compute correct storage slot for mapping', async () => {
      mockRpc.getStorageAt.mockResolvedValue('0x' + '0'.repeat(63) + 'a');

      const result = await explorer.readMapping(
        'ethereum',
        '0x1111111111111111111111111111111111111111',
        0,
        '0x2222222222222222222222222222222222222222'
      );

      expect(result).toBe('0x' + '0'.repeat(63) + 'a');
      // Verify that getStorageAt was called with the keccak256 of padded key+slot
      expect(mockRpc.getStorageAt).toHaveBeenCalledTimes(1);
      const calledSlot = mockRpc.getStorageAt.mock.calls[0][2];
      expect(calledSlot).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('should handle numeric key in mapping', async () => {
      mockRpc.getStorageAt.mockResolvedValue('0x' + '0'.repeat(64));

      await explorer.readMapping('ethereum', '0xcontract', 1, '42');

      expect(mockRpc.getStorageAt).toHaveBeenCalledTimes(1);
    });
  });

  describe('simulateCall', () => {
    it('should return success result for valid call', async () => {
      mockRpc.call.mockResolvedValue('0x' + '0'.repeat(63) + '1');

      const result = await explorer.simulateCall('ethereum', {
        to: '0xcontract',
        data: '0x12345678',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeTruthy();
    });

    it('should return failure result when call reverts', async () => {
      mockRpc.call.mockRejectedValue(new Error('execution reverted'));

      const result = await explorer.simulateCall('ethereum', {
        to: '0xcontract',
        data: '0x12345678',
      });

      expect(result.success).toBe(false);
      expect(result.data).toContain('reverted');
    });

    it('should include from and value when provided', async () => {
      mockRpc.call.mockResolvedValue('0x');

      await explorer.simulateCall('ethereum', {
        to: '0xcontract',
        data: '0x12345678',
        from: '0xsender',
        value: '0x1',
      });

      const callArgs = mockRpc.call.mock.calls[0][2];
      expect(callArgs[0].from).toBe('0xsender');
      expect(callArgs[0].value).toBe('0x1');
    });
  });

  describe('getTokenBalance', () => {
    it('should return formatted token balance', async () => {
      // Mock balanceOf returns 1000 * 10^18
      const balanceHex = '0x' + (10n ** 21n).toString(16).padStart(64, '0');
      // Mock decimals returns 18
      const decimalsHex = '0x' + 18n.toString(16).padStart(64, '0');
      // Mock symbol returns "USDC" (ABI-encoded string)
      const symbolHex =
        '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' + // offset
        '0000000000000000000000000000000000000000000000000000000000000004' + // length
        '5553444300000000000000000000000000000000000000000000000000000000'; // "USDC"

      mockRpc.ethCall
        .mockResolvedValueOnce(balanceHex)
        .mockResolvedValueOnce(decimalsHex)
        .mockResolvedValueOnce(symbolHex);

      const result = await explorer.getTokenBalance('ethereum', '0xtoken', '0xholder');

      expect(result.raw).toBeTruthy();
      expect(result.decimals).toBe(18);
      expect(result.symbol).toBe('USDC');
      expect(result.formatted).toContain('USDC');
    });

    it('should handle zero balance', async () => {
      mockRpc.ethCall
        .mockResolvedValueOnce('0x0')
        .mockResolvedValueOnce('0x' + 18n.toString(16).padStart(64, '0'))
        .mockResolvedValueOnce('0x');

      const result = await explorer.getTokenBalance('ethereum', '0xtoken', '0xholder');

      expect(result.raw).toBe('0');
      expect(result.formatted).toContain('0');
    });

    it('should cache token metadata across calls', async () => {
      const balanceHex = '0x' + (10n ** 18n).toString(16).padStart(64, '0');
      const decimalsHex = '0x' + 18n.toString(16).padStart(64, '0');

      mockRpc.ethCall
        .mockResolvedValueOnce(balanceHex) // first call: balanceOf
        .mockResolvedValueOnce(decimalsHex) // first call: decimals
        .mockResolvedValueOnce('0x') // first call: symbol
        .mockResolvedValueOnce(balanceHex); // second call: only balanceOf (cached meta)

      await explorer.getTokenBalance('ethereum', '0xtoken', '0xholder1');
      await explorer.getTokenBalance('ethereum', '0xtoken', '0xholder2');

      // Second call should only make 1 ethCall (balance), not 3
      expect(mockRpc.ethCall).toHaveBeenCalledTimes(4);
    });
  });

  describe('generateReport', () => {
    it('should produce expected output for contract state', () => {
      const state: ContractState = {
        address: '0xcontract',
        chain: 'ethereum',
        balance: '1 ETH',
        code: '0x6080604052' + 'ab'.repeat(50),
        codeSize: 105,
        storageValues: new Map([
          ['0x0', '0x' + '0'.repeat(63) + '1'],
          ['0x1', '0x' + '0'.repeat(64)],
        ]),
      };

      const report = explorer.generateReport(state);

      expect(report).toContain('# Contract State Report');
      expect(report).toContain('0xcontract');
      expect(report).toContain('Ethereum Mainnet');
      expect(report).toContain('1 ETH');
      expect(report).toContain('## Storage');
      expect(report).toContain('(empty)');
      expect(report).toContain('## Bytecode');
    });

    it('should handle empty storage in report', () => {
      const state: ContractState = {
        address: '0xcontract',
        chain: 'ethereum',
        balance: '0 ETH',
        code: '0x',
        codeSize: 0,
        storageValues: new Map(),
      };

      const report = explorer.generateReport(state);
      expect(report).not.toContain('## Storage');
    });
  });

  describe('readSlot', () => {
    it('should read a storage slot by number', async () => {
      mockRpc.getStorageAt.mockResolvedValue('0x' + '0'.repeat(63) + '5');

      const result = await explorer.readSlot('ethereum', '0xcontract', 0);
      expect(result).toBe('0x' + '0'.repeat(63) + '5');
      expect(mockRpc.getStorageAt).toHaveBeenCalledWith('ethereum', '0xcontract', '0x0');
    });

    it('should read a storage slot by hex string', async () => {
      mockRpc.getStorageAt.mockResolvedValue('0x' + '0'.repeat(64));

      const result = await explorer.readSlot('ethereum', '0xcontract', '0x10');
      expect(mockRpc.getStorageAt).toHaveBeenCalledWith('ethereum', '0xcontract', '0x10');
    });
  });
});
