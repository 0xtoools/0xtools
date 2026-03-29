/**
 * Tests for RpcProvider — Multi-chain RPC Provider
 */

jest.mock('https', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EventEmitter = require('events');
  return {
    Agent: jest.fn(() => ({})),
    request: jest.fn(),
  };
});

jest.mock('http', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const EventEmitter = require('events');
  return {
    Agent: jest.fn(() => ({})),
    request: jest.fn(),
  };
});

import { RpcProvider, DEFAULT_CHAINS } from '../rpc-provider';
import * as https from 'https';
import * as http from 'http';
import { EventEmitter } from 'events';

function mockHttpResponse(mod: typeof https | typeof http, responseBody: any, statusCode = 200) {
  const mockReq = new EventEmitter() as any;
  mockReq.write = jest.fn();
  mockReq.end = jest.fn();
  mockReq.destroy = jest.fn();

  (mod.request as jest.Mock).mockImplementation((_opts: any, callback: any) => {
    const mockRes = new EventEmitter() as any;
    mockRes.statusCode = statusCode;
    process.nextTick(() => {
      callback(mockRes);
      mockRes.emit('data', Buffer.from(JSON.stringify(responseBody)));
      mockRes.emit('end');
    });
    return mockReq;
  });

  return mockReq;
}

describe('RpcProvider', () => {
  let provider: RpcProvider;

  beforeEach(() => {
    provider = new RpcProvider();
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create default chains on construction', () => {
      const chains = provider.getChains();
      expect(chains).toContain('ethereum');
      expect(chains).toContain('polygon');
      expect(chains).toContain('arbitrum');
      expect(chains).toContain('optimism');
      expect(chains).toContain('bsc');
      expect(chains).toContain('base');
    });

    it('should have chain configs with required fields', () => {
      const ethConfig = provider.getChain('ethereum');
      expect(ethConfig).toBeDefined();
      expect(ethConfig!.chainId).toBe(1);
      expect(ethConfig!.name).toBe('Ethereum Mainnet');
      expect(ethConfig!.currency).toBe('ETH');
      expect(ethConfig!.decimals).toBe(18);
      expect(ethConfig!.rpcUrl).toBeTruthy();
    });
  });

  describe('setEndpoint', () => {
    it('should override the RPC URL for a chain', () => {
      provider.setEndpoint('ethereum', 'https://custom-rpc.example.com');
      // The custom endpoint is used internally; verify by triggering a call
      mockHttpResponse(https, { jsonrpc: '2.0', id: 1, result: '0x1' });

      // The chain should still be found
      expect(provider.getChain('ethereum')).toBeDefined();
    });

    it('should allow setting endpoint for unknown chain name', () => {
      provider.setEndpoint('custom-chain', 'https://custom.example.com');
      // This should not throw since custom endpoints bypass chain lookup
    });
  });

  describe('addChain', () => {
    it('should add a new chain', () => {
      provider.addChain('zkSync', {
        chainId: 324,
        name: 'zkSync Era',
        rpcUrl: 'https://mainnet.era.zksync.io',
        currency: 'ETH',
        decimals: 18,
      });

      const chains = provider.getChains();
      expect(chains).toContain('zkSync');

      const config = provider.getChain('zkSync');
      expect(config).toBeDefined();
      expect(config!.chainId).toBe(324);
      expect(config!.name).toBe('zkSync Era');
    });

    it('should overwrite existing chain when adding with same name', () => {
      provider.addChain('ethereum', {
        chainId: 1,
        name: 'Custom Ethereum',
        rpcUrl: 'https://custom.example.com',
        currency: 'ETH',
        decimals: 18,
      });

      const config = provider.getChain('ethereum');
      expect(config!.name).toBe('Custom Ethereum');
    });
  });

  describe('getChains', () => {
    it('should return all default chain names', () => {
      const chains = provider.getChains();
      const defaultChainNames = Object.keys(DEFAULT_CHAINS);
      for (const name of defaultChainNames) {
        expect(chains).toContain(name);
      }
    });

    it('should include custom chains after adding', () => {
      provider.addChain('testnet', {
        chainId: 999,
        name: 'TestNet',
        rpcUrl: 'http://localhost:8545',
        currency: 'TEST',
        decimals: 18,
      });
      expect(provider.getChains()).toContain('testnet');
    });
  });

  describe('formatValue', () => {
    it('should format zero wei correctly', () => {
      const result = provider.formatValue(0n, 'ethereum');
      expect(result).toBe('0 ETH');
    });

    it('should format 1 ETH correctly', () => {
      const oneEth = 10n ** 18n;
      const result = provider.formatValue(oneEth, 'ethereum');
      expect(result).toBe('1 ETH');
    });

    it('should format 1.5 ETH correctly', () => {
      const oneAndHalfEth = 15n * 10n ** 17n;
      const result = provider.formatValue(oneAndHalfEth, 'ethereum');
      expect(result).toBe('1.5 ETH');
    });

    it('should use correct currency for different chains', () => {
      const oneUnit = 10n ** 18n;
      const result = provider.formatValue(oneUnit, 'polygon');
      expect(result).toBe('1 MATIC');
    });

    it('should trim trailing zeros in fractional part', () => {
      const value = 10n ** 17n; // 0.1 ETH
      const result = provider.formatValue(value, 'ethereum');
      expect(result).toBe('0.1 ETH');
    });

    it('should default to ETH for unknown chain', () => {
      const oneUnit = 10n ** 18n;
      const result = provider.formatValue(oneUnit, 'unknown-chain');
      expect(result).toBe('1 ETH');
    });

    it('should handle large values', () => {
      const million = 1000000n * 10n ** 18n;
      const result = provider.formatValue(million, 'ethereum');
      expect(result).toBe('1000000 ETH');
    });
  });

  describe('call', () => {
    it('should make a JSON-RPC call and return the result', async () => {
      mockHttpResponse(https, {
        jsonrpc: '2.0',
        id: 1,
        result: '0x1',
      });

      const result = await provider.call('ethereum', 'eth_chainId', []);
      expect(result).toBe('0x1');
    });

    it('should throw on RPC error response', async () => {
      mockHttpResponse(https, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request' },
      });

      await expect(provider.call('ethereum', 'eth_chainId', [])).rejects.toThrow('RPC error');
    });

    it('should throw for unknown chain', async () => {
      await expect(provider.call('nonexistent', 'eth_chainId', [])).rejects.toThrow(
        'Unknown chain'
      );
    });

    it('should throw when no response is returned', async () => {
      mockHttpResponse(https, null);

      // The httpPost will try to parse null as JSON which will reject
      await expect(provider.call('ethereum', 'eth_chainId', [])).rejects.toThrow();
    });
  });

  describe('Cache behavior', () => {
    it('should cache getBalance calls', async () => {
      mockHttpResponse(https, {
        jsonrpc: '2.0',
        id: 1,
        result: '0xde0b6b3a7640000', // 1 ETH
      });

      const balance1 = await provider.getBalance(
        'ethereum',
        '0x1234567890abcdef1234567890abcdef12345678'
      );
      const balance2 = await provider.getBalance(
        'ethereum',
        '0x1234567890abcdef1234567890abcdef12345678'
      );

      // Should only have made one HTTP request due to caching
      expect(balance1).toEqual(balance2);
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('should clear cache when clearCache is called', async () => {
      mockHttpResponse(https, {
        jsonrpc: '2.0',
        id: 1,
        result: '0xde0b6b3a7640000',
      });

      await provider.getBalance('ethereum', '0x1234567890abcdef1234567890abcdef12345678');
      provider.clearCache();

      mockHttpResponse(https, {
        jsonrpc: '2.0',
        id: 2,
        result: '0xde0b6b3a7640000',
      });

      await provider.getBalance('ethereum', '0x1234567890abcdef1234567890abcdef12345678');

      expect(https.request).toHaveBeenCalledTimes(2);
    });
  });

  describe('getChain', () => {
    it('should return undefined for unknown chain', () => {
      expect(provider.getChain('nonexistent')).toBeUndefined();
    });

    it('should return config for known chain', () => {
      const config = provider.getChain('ethereum');
      expect(config).toBeDefined();
      expect(config!.chainId).toBe(1);
    });
  });
});
