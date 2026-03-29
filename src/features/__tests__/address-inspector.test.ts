/**
 * Tests for AddressInspector — Address inspection and proxy detection
 */

import { AddressInspector, AddressInfo } from '../address-inspector';

function createMockRpc() {
  return {
    getBalance: jest.fn(),
    getTransactionCount: jest.fn(),
    getCode: jest.fn(),
    getStorageAt: jest.fn(),
    getChain: jest.fn().mockReturnValue({
      chainId: 1,
      name: 'Ethereum Mainnet',
      rpcUrl: 'https://eth.llamarpc.com',
      explorerUrl: 'https://etherscan.io',
      currency: 'ETH',
      decimals: 18,
    }),
    formatValue: jest.fn((wei: bigint, _chain: string) => {
      if (wei === 0n) {
        return '0 ETH';
      }
      const eth = Number(wei) / 1e18;
      return `${eth} ETH`;
    }),
  } as any;
}

describe('AddressInspector', () => {
  let inspector: AddressInspector;
  let mockRpc: ReturnType<typeof createMockRpc>;

  const ZERO_SLOT = '0x' + '0'.repeat(64);

  beforeEach(() => {
    mockRpc = createMockRpc();
    inspector = new AddressInspector(mockRpc);
  });

  describe('Constructor', () => {
    it('should create inspector with provided RpcProvider', () => {
      expect(inspector).toBeDefined();
    });

    it('should create inspector without RpcProvider', () => {
      const defaultInspector = new AddressInspector();
      expect(defaultInspector).toBeDefined();
    });
  });

  describe('isContract', () => {
    it('should return true for addresses with code', async () => {
      mockRpc.getCode.mockResolvedValue('0x6080604052');
      const result = await inspector.isContract(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );
      expect(result).toBe(true);
    });

    it('should return false for EOAs (no code)', async () => {
      mockRpc.getCode.mockResolvedValue('0x');
      const result = await inspector.isContract(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );
      expect(result).toBe(false);
    });

    it('should return false for code value "0x0"', async () => {
      mockRpc.getCode.mockResolvedValue('0x0');
      const result = await inspector.isContract(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );
      expect(result).toBe(false);
    });

    it('should normalize address to lowercase', async () => {
      mockRpc.getCode.mockResolvedValue('0x');
      await inspector.isContract('0xAbCdEf1234567890AbCdEf1234567890AbCdEf12', 'ethereum');
      expect(mockRpc.getCode).toHaveBeenCalledWith(
        'ethereum',
        '0xabcdef1234567890abcdef1234567890abcdef12'
      );
    });
  });

  describe('detectProxy', () => {
    it('should detect EIP-1967 implementation proxy', async () => {
      const implAddr = '0x' + '0'.repeat(24) + 'abcdef1234567890abcdef1234567890abcdef12';
      mockRpc.getStorageAt
        .mockResolvedValueOnce(implAddr) // implementation slot
        .mockResolvedValueOnce(ZERO_SLOT) // admin slot
        .mockResolvedValueOnce(ZERO_SLOT); // beacon slot

      const result = await inspector.detectProxy(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );

      expect(result.isProxy).toBe(true);
      expect(result.implementation).toContain('abcdef1234567890abcdef1234567890abcdef12');
    });

    it('should return isProxy=false for non-proxy contracts', async () => {
      mockRpc.getStorageAt
        .mockResolvedValueOnce(ZERO_SLOT) // implementation slot = zero
        .mockResolvedValueOnce(ZERO_SLOT) // admin slot = zero
        .mockResolvedValueOnce(ZERO_SLOT); // beacon slot = zero

      const result = await inspector.detectProxy(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );

      expect(result.isProxy).toBe(false);
      expect(result.implementation).toBeUndefined();
    });

    it('should return isProxy=false when storage read fails', async () => {
      mockRpc.getStorageAt.mockRejectedValue(new Error('RPC error'));

      const result = await inspector.detectProxy(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );

      expect(result.isProxy).toBe(false);
    });

    it('should cache proxy detection results', async () => {
      const implAddr = '0x' + '0'.repeat(24) + 'abcdef1234567890abcdef1234567890abcdef12';
      mockRpc.getStorageAt
        .mockResolvedValueOnce(implAddr)
        .mockResolvedValueOnce(ZERO_SLOT)
        .mockResolvedValueOnce(ZERO_SLOT);

      const result1 = await inspector.detectProxy(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );
      const result2 = await inspector.detectProxy(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );

      expect(result1).toEqual(result2);
      // Only 3 calls for the first detection (impl, admin, beacon)
      expect(mockRpc.getStorageAt).toHaveBeenCalledTimes(3);
    });
  });

  describe('inspect', () => {
    it('should inspect an EOA address', async () => {
      mockRpc.getBalance.mockResolvedValue(10n ** 18n);
      mockRpc.getTransactionCount.mockResolvedValue(5);
      mockRpc.getCode.mockResolvedValue('0x');

      const info = await inspector.inspect(
        '0x1111111111111111111111111111111111111111',
        'ethereum'
      );

      expect(info.type).toBe('eoa');
      expect(info.nonce).toBe(5);
      expect(info.transactionCount).toBe(5);
      expect(info.code).toBeUndefined();
      expect(info.codeSize).toBeUndefined();
      expect(info.isProxy).toBeUndefined();
    });

    it('should inspect a contract address', async () => {
      mockRpc.getBalance.mockResolvedValue(0n);
      mockRpc.getTransactionCount.mockResolvedValue(0);
      mockRpc.getCode.mockResolvedValue('0x6080604052' + 'ab'.repeat(100));
      // Proxy detection: no proxy
      mockRpc.getStorageAt.mockResolvedValue(ZERO_SLOT);

      const info = await inspector.inspect(
        '0x2222222222222222222222222222222222222222',
        'ethereum'
      );

      expect(info.type).toBe('contract');
      expect(info.code).toBeTruthy();
      expect(info.codeSize).toBeGreaterThan(0);
      expect(info.isProxy).toBe(false);
    });

    it('should normalize address in inspect result', async () => {
      mockRpc.getBalance.mockResolvedValue(0n);
      mockRpc.getTransactionCount.mockResolvedValue(0);
      mockRpc.getCode.mockResolvedValue('0x');

      const info = await inspector.inspect(
        '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        'ethereum'
      );

      expect(info.address).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });
  });

  describe('generateReport', () => {
    it('should produce expected markdown sections for EOA', () => {
      const info: AddressInfo = {
        address: '0x1111111111111111111111111111111111111111',
        chain: 'ethereum',
        type: 'eoa',
        balance: '1 ETH',
        balanceWei: '1000000000000000000',
        nonce: 10,
        transactionCount: 10,
      };

      const report = inspector.generateReport(info);

      expect(report).toContain('# Address Inspection');
      expect(report).toContain('Externally Owned Account (EOA)');
      expect(report).toContain('## Balance');
      expect(report).toContain('1 ETH');
      expect(report).toContain('Nonce / Tx Count');
      expect(report).toContain('etherscan.io');
    });

    it('should produce expected markdown sections for contract', () => {
      const info: AddressInfo = {
        address: '0x2222222222222222222222222222222222222222',
        chain: 'ethereum',
        type: 'contract',
        balance: '0 ETH',
        balanceWei: '0',
        nonce: 0,
        transactionCount: 0,
        code: '0x6080604052' + 'ab'.repeat(100),
        codeSize: 205,
        isProxy: false,
      };

      const report = inspector.generateReport(info);

      expect(report).toContain('Contract');
      expect(report).toContain('## Contract Details');
      expect(report).toContain('Code Size');
      expect(report).toContain('EIP-170');
      expect(report).toContain('### Bytecode Preview');
    });

    it('should show proxy info when detected', () => {
      const info: AddressInfo = {
        address: '0x3333333333333333333333333333333333333333',
        chain: 'ethereum',
        type: 'contract',
        balance: '0 ETH',
        balanceWei: '0',
        nonce: 0,
        transactionCount: 0,
        code: '0x3636',
        codeSize: 2,
        isProxy: true,
        implementationAddress: '0x4444444444444444444444444444444444444444',
      };

      const report = inspector.generateReport(info);

      expect(report).toContain('Proxy Detected');
      expect(report).toContain('EIP-1967');
      expect(report).toContain('Implementation');
      expect(report).toContain('0x4444444444444444444444444444444444444444');
    });

    it('should show storage slots when non-zero values exist', () => {
      const info: AddressInfo = {
        address: '0x5555555555555555555555555555555555555555',
        chain: 'ethereum',
        type: 'contract',
        balance: '0 ETH',
        balanceWei: '0',
        nonce: 0,
        transactionCount: 0,
        code: '0x6080',
        codeSize: 2,
        isProxy: false,
        storageSlots: [
          { slot: '0x0', value: '0x' + '0'.repeat(63) + '1' },
          { slot: '0x1', value: '0x' + '0'.repeat(64) },
        ],
      };

      const report = inspector.generateReport(info);
      expect(report).toContain('Storage Slots');
    });
  });

  describe('readStorage', () => {
    it('should read a single storage slot', async () => {
      mockRpc.getStorageAt.mockResolvedValue('0x' + '0'.repeat(63) + '1');

      const value = await inspector.readStorage(
        '0x1111111111111111111111111111111111111111',
        'ethereum',
        '0x0'
      );

      expect(value).toBe('0x' + '0'.repeat(63) + '1');
      expect(mockRpc.getStorageAt).toHaveBeenCalledWith(
        'ethereum',
        '0x1111111111111111111111111111111111111111',
        '0x0'
      );
    });
  });

  describe('readStorageRange', () => {
    it('should read multiple sequential storage slots', async () => {
      mockRpc.getStorageAt
        .mockResolvedValueOnce('0x' + '0'.repeat(63) + '1')
        .mockResolvedValueOnce('0x' + '0'.repeat(63) + '2')
        .mockResolvedValueOnce('0x' + '0'.repeat(63) + '3');

      const result = await inspector.readStorageRange(
        '0x1111111111111111111111111111111111111111',
        'ethereum',
        0,
        3
      );

      expect(result.length).toBe(3);
      expect(result[0].slot).toBe('0x0');
      expect(result[1].slot).toBe('0x1');
      expect(result[2].slot).toBe('0x2');
    });
  });
});
