/**
 * Tests for TxInspector — Transaction Inspector
 */

jest.mock('../four-byte-lookup', () => ({
  FourByteLookup: jest.fn().mockImplementation(() => ({
    lookup: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('js-sha3', () => ({
  keccak256: jest.fn((data: string) => {
    // Return deterministic hashes for known event signatures
    const knownHashes: Record<string, string> = {
      'Transfer(address,address,uint256)':
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      'Approval(address,address,uint256)':
        '8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    };
    return knownHashes[data] || '0000000000000000000000000000000000000000000000000000000000000000';
  }),
}));

import { TxInspector, TransactionDetails } from '../tx-inspector';

function createMockRpc() {
  return {
    getTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
    getBlock: jest.fn(),
    getChain: jest.fn().mockReturnValue({
      chainId: 1,
      name: 'Ethereum Mainnet',
      rpcUrl: 'https://eth.llamarpc.com',
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

describe('TxInspector', () => {
  let inspector: TxInspector;
  let mockRpc: ReturnType<typeof createMockRpc>;

  beforeEach(() => {
    mockRpc = createMockRpc();
    inspector = new TxInspector(mockRpc);
  });

  describe('Constructor', () => {
    it('should create inspector with provided RpcProvider', () => {
      expect(inspector).toBeDefined();
    });

    it('should create inspector without RpcProvider (uses default)', () => {
      const defaultInspector = new TxInspector();
      expect(defaultInspector).toBeDefined();
    });
  });

  describe('inspect', () => {
    it('should fetch and decode a successful transaction', async () => {
      const mockTx = {
        hash: '0xabc123',
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0xde0b6b3a7640000', // 1 ETH
        gas: '0x5208', // 21000
        gasPrice: '0x3b9aca00', // 1 gwei
        nonce: '0x5',
        input: '0x',
        blockNumber: '0xf4240', // 1000000
      };

      const mockReceipt = {
        status: '0x1',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        logs: [],
      };

      const mockBlock = {
        timestamp: '0x64000000',
      };

      mockRpc.getTransaction.mockResolvedValue(mockTx);
      mockRpc.getTransactionReceipt.mockResolvedValue(mockReceipt);
      mockRpc.getBlock.mockResolvedValue(mockBlock);

      const result = await inspector.inspect('0xabc123', 'ethereum');

      expect(result.hash).toBe('0xabc123');
      expect(result.status).toBe('success');
      expect(result.from).toBe('0x1111111111111111111111111111111111111111');
      expect(result.to).toBe('0x2222222222222222222222222222222222222222');
      expect(result.gasUsed).toBe(21000);
      expect(result.gasLimit).toBe(21000);
      expect(result.nonce).toBe(5);
      expect(result.chain).toBe('ethereum');
    });

    it('should handle reverted transaction', async () => {
      mockRpc.getTransaction.mockResolvedValue({
        hash: '0xdef456',
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0x0',
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
        nonce: '0x0',
        input: '0x',
        blockNumber: '0x1',
      });

      mockRpc.getTransactionReceipt.mockResolvedValue({
        status: '0x0',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        logs: [],
      });

      mockRpc.getBlock.mockResolvedValue({ timestamp: '0x64000000' });

      const result = await inspector.inspect('0xdef456', 'ethereum');
      expect(result.status).toBe('reverted');
    });

    it('should handle pending transaction (no receipt)', async () => {
      mockRpc.getTransaction.mockResolvedValue({
        hash: '0xpending',
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0x0',
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
        nonce: '0x0',
        input: '0x',
        blockNumber: null,
      });

      mockRpc.getTransactionReceipt.mockResolvedValue(null);

      const result = await inspector.inspect('0xpending', 'ethereum');
      expect(result.status).toBe('pending');
      expect(result.blockNumber).toBeNull();
    });

    it('should throw when transaction is not found', async () => {
      mockRpc.getTransaction.mockResolvedValue(null);
      mockRpc.getTransactionReceipt.mockResolvedValue(null);

      await expect(inspector.inspect('0xnotfound', 'ethereum')).rejects.toThrow(
        'Transaction 0xnotfound not found'
      );
    });

    it('should detect contract creation', async () => {
      mockRpc.getTransaction.mockResolvedValue({
        hash: '0xcreate',
        from: '0x1111111111111111111111111111111111111111',
        to: null,
        value: '0x0',
        gas: '0x100000',
        gasPrice: '0x3b9aca00',
        nonce: '0x0',
        input: '0x6080604052',
        blockNumber: '0x1',
      });

      mockRpc.getTransactionReceipt.mockResolvedValue({
        status: '0x1',
        gasUsed: '0x50000',
        effectiveGasPrice: '0x3b9aca00',
        contractAddress: '0x3333333333333333333333333333333333333333',
        logs: [],
      });

      mockRpc.getBlock.mockResolvedValue({ timestamp: '0x64000000' });

      const result = await inspector.inspect('0xcreate', 'ethereum');
      expect(result.contractCreated).toBe('0x3333333333333333333333333333333333333333');
      expect(result.to).toBeNull();
    });
  });

  describe('decodeCalldata', () => {
    it('should return raw selector info when no signature is found', async () => {
      const selector = '0x12345678';
      const data = '0x12345678' + '0'.repeat(64);

      const result = await inspector.decodeCalldata(selector, data);

      expect(result).toBeDefined();
      expect(result!.selector).toBe(selector);
      expect(result!.functionName).toContain('unknown');
      expect(result!.args.length).toBeGreaterThan(0);
    });

    it('should split calldata into 32-byte words', async () => {
      const selector = '0xabcdef01';
      const word1 = '0'.repeat(64);
      const word2 = '1'.padStart(64, '0');
      const data = '0xabcdef01' + word1 + word2;

      const result = await inspector.decodeCalldata(selector, data);
      expect(result).toBeDefined();
      expect(result!.args.length).toBe(2);
    });
  });

  describe('generateReport', () => {
    it('should produce markdown with expected sections', () => {
      const txDetails: TransactionDetails = {
        hash: '0xabc123def456',
        chain: 'ethereum',
        status: 'success',
        blockNumber: 1000000,
        timestamp: 1700000000,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '1 ETH',
        valueWei: '1000000000000000000',
        gasUsed: 21000,
        gasLimit: 21000,
        gasPrice: '1.0000',
        nonce: 5,
        input: '0x',
        events: [],
        internalCalls: [],
        cost: '0.000021 ETH',
        effectiveGasPrice: '1.0000',
      };

      const report = inspector.generateReport(txDetails);

      expect(report).toContain('# Transaction Details');
      expect(report).toContain('0xabc123def456');
      expect(report).toContain('(ok) Success');
      expect(report).toContain('## Addresses');
      expect(report).toContain('## Value Transfer');
      expect(report).toContain('1 ETH');
      expect(report).toContain('Nonce');
    });

    it('should include events section when events exist', () => {
      const txDetails: TransactionDetails = {
        hash: '0x123',
        chain: 'ethereum',
        status: 'success',
        blockNumber: 100,
        timestamp: null,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0 ETH',
        valueWei: '0',
        gasUsed: 50000,
        gasLimit: 100000,
        gasPrice: '10.0000',
        nonce: 0,
        input: '0xa9059cbb',
        events: [
          {
            address: '0x2222222222222222222222222222222222222222',
            name: 'Transfer',
            topic0: '0xddf252ad',
            topics: ['0xddf252ad'],
            data: '0x',
            logIndex: 0,
          },
        ],
        internalCalls: [],
        cost: '0.0005 ETH',
        effectiveGasPrice: '10.0000',
      };

      const report = inspector.generateReport(txDetails);
      expect(report).toContain('## Events (1)');
      expect(report).toContain('Transfer');
    });

    it('should handle reverted status in report', () => {
      const txDetails: TransactionDetails = {
        hash: '0xfail',
        chain: 'ethereum',
        status: 'reverted',
        blockNumber: 100,
        timestamp: null,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0 ETH',
        valueWei: '0',
        gasUsed: 21000,
        gasLimit: 21000,
        gasPrice: '1.0000',
        nonce: 0,
        input: '0x',
        events: [],
        internalCalls: [],
        cost: '0 ETH',
        effectiveGasPrice: '1.0000',
      };

      const report = inspector.generateReport(txDetails);
      expect(report).toContain('(failed) Reverted');
    });

    it('should include EIP-1559 fields when present', () => {
      const txDetails: TransactionDetails = {
        hash: '0x1559',
        chain: 'ethereum',
        status: 'success',
        blockNumber: 100,
        timestamp: null,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '0 ETH',
        valueWei: '0',
        gasUsed: 21000,
        gasLimit: 21000,
        gasPrice: '10.0000',
        maxFeePerGas: '20.0000',
        maxPriorityFee: '2.0000',
        nonce: 0,
        input: '0x',
        events: [],
        internalCalls: [],
        cost: '0 ETH',
        effectiveGasPrice: '10.0000',
      };

      const report = inspector.generateReport(txDetails);
      expect(report).toContain('Max Fee Per Gas');
      expect(report).toContain('Max Priority Fee');
    });
  });
});
