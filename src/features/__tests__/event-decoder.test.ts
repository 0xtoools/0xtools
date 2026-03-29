/**
 * Tests for EventDecoder — Event log decoder
 */

import { keccak256 } from 'js-sha3';
import { EventDecoder, DecodedEvent, EventFilter } from '../event-decoder';

function createMockRpc() {
  return {
    getLogs: jest.fn().mockResolvedValue([]),
    getChain: jest.fn().mockReturnValue({
      chainId: 1,
      name: 'Ethereum Mainnet',
      currency: 'ETH',
      decimals: 18,
    }),
  } as any;
}

describe('EventDecoder', () => {
  let decoder: EventDecoder;
  let mockRpc: ReturnType<typeof createMockRpc>;
  let transferTopic0: string;

  beforeEach(() => {
    mockRpc = createMockRpc();
    decoder = new EventDecoder(mockRpc);
    transferTopic0 = '0x' + keccak256('Transfer(address,address,uint256)');
  });

  describe('Constructor', () => {
    it('should create decoder with provided RpcProvider', () => {
      expect(decoder).toBeDefined();
    });

    it('should create decoder without RpcProvider (uses default)', () => {
      const defaultDecoder = new EventDecoder();
      expect(defaultDecoder).toBeDefined();
    });

    it('should register common events in constructor', () => {
      // Verify that a known Transfer event can be decoded
      const log = {
        topics: [
          transferTopic0,
          '0x0000000000000000000000001111111111111111111111111111111111111111',
          '0x0000000000000000000000002222222222222222222222222222222222222222',
        ],
        data: '0x' + '0'.repeat(63) + '1',
        address: '0x3333333333333333333333333333333333333333',
        blockNumber: '0x1',
        transactionHash: '0xabc',
        logIndex: '0x0',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.name).toBe('Transfer');
      expect(decoded.eventSignature).toBe('Transfer(address,address,uint256)');
    });
  });

  describe('registerCommonEvents', () => {
    it('should be idempotent (no-op since events are pre-loaded)', () => {
      // Call multiple times - should not throw or change behavior
      decoder.registerCommonEvents();
      decoder.registerCommonEvents();
      decoder.registerCommonEvents();

      const log = {
        topics: [
          transferTopic0,
          '0x0000000000000000000000001111111111111111111111111111111111111111',
          '0x0000000000000000000000002222222222222222222222222222222222222222',
        ],
        data: '0x' + '0'.repeat(63) + '1',
        address: '0x3333333333333333333333333333333333333333',
        blockNumber: '0x1',
        transactionHash: '0xabc',
        logIndex: '0x0',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.name).toBe('Transfer');
    });
  });

  describe('registerEvent', () => {
    it('should register a custom event and decode it', () => {
      decoder.registerEvent('MyEvent(uint256,address)', [
        { name: 'id', type: 'uint256', indexed: true },
        { name: 'sender', type: 'address', indexed: false },
      ]);

      const myEventTopic0 = '0x' + keccak256('MyEvent(uint256,address)');
      const log = {
        topics: [
          myEventTopic0,
          '0x' + '0'.repeat(63) + 'a', // id = 10
        ],
        data: '0x' + '0'.repeat(24) + '1111111111111111111111111111111111111111',
        address: '0xcontract',
        blockNumber: '0x10',
        transactionHash: '0xdef',
        logIndex: '0x1',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.name).toBe('MyEvent');
      expect(decoded.args.length).toBe(2);
      expect(decoded.args[0].name).toBe('id');
      expect(decoded.args[0].indexed).toBe(true);
      expect(decoded.args[1].name).toBe('sender');
      expect(decoded.args[1].indexed).toBe(false);
    });
  });

  describe('decodeLog', () => {
    it('should decode a known Transfer event log', () => {
      const fromAddr = '0000000000000000000000001111111111111111111111111111111111111111';
      const toAddr = '0000000000000000000000002222222222222222222222222222222222222222';
      const amount = '0'.repeat(63) + '1'; // 1 token

      const log = {
        topics: [transferTopic0, '0x' + fromAddr, '0x' + toAddr],
        data: '0x' + amount,
        address: '0xtoken',
        blockNumber: '0xa',
        transactionHash: '0xhash',
        logIndex: '0x3',
      };

      const decoded = decoder.decodeLog(log);

      expect(decoded.name).toBe('Transfer');
      expect(decoded.eventSignature).toBe('Transfer(address,address,uint256)');
      expect(decoded.logIndex).toBe(3);
      expect(decoded.blockNumber).toBe(10);
      expect(decoded.args.length).toBe(3);

      // from (indexed)
      expect(decoded.args[0].name).toBe('from');
      expect(decoded.args[0].type).toBe('address');
      expect(decoded.args[0].indexed).toBe(true);
      expect(decoded.args[0].value).toContain('1111111111111111111111111111111111111111');

      // to (indexed)
      expect(decoded.args[1].name).toBe('to');
      expect(decoded.args[1].type).toBe('address');
      expect(decoded.args[1].indexed).toBe(true);

      // value (non-indexed, from data)
      expect(decoded.args[2].name).toBe('value');
      expect(decoded.args[2].type).toBe('uint256');
      expect(decoded.args[2].indexed).toBe(false);
      expect(decoded.args[2].value).toBe('1');
    });

    it('should return raw data for unknown event', () => {
      const unknownTopic0 = '0x' + 'ff'.repeat(32);
      const log = {
        topics: [unknownTopic0, '0x' + '0'.repeat(64)],
        data: '0x' + 'ab'.repeat(32),
        address: '0xcontract',
        blockNumber: '0x5',
        transactionHash: '0xunknown',
        logIndex: '0x0',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.name).toBeUndefined();
      expect(decoded.eventSignature).toBeUndefined();
      expect(decoded.topic0).toBe(unknownTopic0);
      // Should have raw topic and data args
      expect(decoded.args.some((a) => a.name.startsWith('topic'))).toBe(true);
      expect(decoded.args.some((a) => a.name.startsWith('data'))).toBe(true);
    });

    it('should handle log with empty data', () => {
      const ownershipTopic0 = '0x' + keccak256('OwnershipTransferred(address,address)');
      const log = {
        topics: [
          ownershipTopic0,
          '0x0000000000000000000000001111111111111111111111111111111111111111',
          '0x0000000000000000000000002222222222222222222222222222222222222222',
        ],
        data: '0x',
        address: '0xcontract',
        blockNumber: '0x1',
        transactionHash: '0xhash',
        logIndex: '0x0',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.name).toBe('OwnershipTransferred');
      expect(decoded.args.length).toBe(2);
    });

    it('should handle log with no topics', () => {
      const log = {
        topics: [],
        data: '0x',
        address: '0xcontract',
        blockNumber: '0x1',
        transactionHash: '0xhash',
        logIndex: '0x0',
      };

      const decoded = decoder.decodeLog(log);
      expect(decoded.topic0).toBe('');
      expect(decoded.name).toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('should fetch and decode events', async () => {
      const fromAddr = '0000000000000000000000001111111111111111111111111111111111111111';
      const toAddr = '0000000000000000000000002222222222222222222222222222222222222222';

      mockRpc.getLogs.mockResolvedValue([
        {
          topics: [transferTopic0, '0x' + fromAddr, '0x' + toAddr],
          data: '0x' + '0'.repeat(63) + '1',
          address: '0xtoken',
          blockNumber: '0xa',
          transactionHash: '0xhash',
          logIndex: '0x0',
        },
      ]);

      const filter: EventFilter = { chain: 'ethereum', address: '0xtoken' };
      const events = await decoder.getEvents(filter);

      expect(events.length).toBe(1);
      expect(events[0].name).toBe('Transfer');
    });

    it('should return empty array when no logs found', async () => {
      mockRpc.getLogs.mockResolvedValue([]);

      const events = await decoder.getEvents({ chain: 'ethereum' });
      expect(events).toEqual([]);
    });

    it('should handle non-array response', async () => {
      mockRpc.getLogs.mockResolvedValue(null);

      const events = await decoder.getEvents({ chain: 'ethereum' });
      expect(events).toEqual([]);
    });
  });

  describe('generateReport', () => {
    it('should produce markdown report', () => {
      const events: DecodedEvent[] = [
        {
          address: '0xtoken',
          blockNumber: 100,
          transactionHash: '0xhash',
          logIndex: 0,
          topic0: transferTopic0,
          name: 'Transfer',
          eventSignature: 'Transfer(address,address,uint256)',
          args: [
            { name: 'from', type: 'address', value: '0x1111', indexed: true },
            { name: 'to', type: 'address', value: '0x2222', indexed: true },
            { name: 'value', type: 'uint256', value: '1000', indexed: false },
          ],
          raw: { topics: [transferTopic0], data: '0x' },
        },
      ];

      const filter: EventFilter = { chain: 'ethereum', address: '0xtoken' };
      const report = decoder.generateReport(events, filter);

      expect(report).toContain('# Event Log Report');
      expect(report).toContain('Ethereum Mainnet');
      expect(report).toContain('Events Found:** 1');
      expect(report).toContain('Transfer');
      expect(report).toContain('from');
      expect(report).toContain('to');
      expect(report).toContain('value');
    });

    it('should handle empty events in report', () => {
      const filter: EventFilter = { chain: 'ethereum' };
      const report = decoder.generateReport([], filter);
      expect(report).toContain('No events found');
    });
  });
});
