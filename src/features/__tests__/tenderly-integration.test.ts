/**
 * Tests for TenderlyIntegration — Transaction tracing and simulation
 */

jest.mock('https', () => {
  return {
    request: jest.fn(),
  };
});

jest.mock('http', () => {
  return {
    request: jest.fn(),
  };
});

import {
  TenderlyIntegration,
  TenderlyConfig,
  TenderlyTrace,
  TenderlyCallNode,
} from '../tenderly-integration';
import * as https from 'https';
import { EventEmitter } from 'events';

function mockHttpsResponse(responseBody: any, statusCode = 200) {
  const mockReq = new EventEmitter() as any;
  mockReq.write = jest.fn();
  mockReq.end = jest.fn();
  mockReq.destroy = jest.fn();

  (https.request as jest.Mock).mockImplementation((_opts: any, callback: any) => {
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

describe('TenderlyIntegration', () => {
  let tenderly: TenderlyIntegration;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isConfigured', () => {
    it('should return false when no keys provided', () => {
      tenderly = new TenderlyIntegration();
      expect(tenderly.isConfigured()).toBe(false);
    });

    it('should return false when only partial config provided', () => {
      tenderly = new TenderlyIntegration({ accessKey: 'key123' });
      expect(tenderly.isConfigured()).toBe(false);
    });

    it('should return true when all keys provided', () => {
      tenderly = new TenderlyIntegration({
        accessKey: 'key123',
        accountSlug: 'myaccount',
        projectSlug: 'myproject',
      });
      expect(tenderly.isConfigured()).toBe(true);
    });

    it('should return false when keys are empty strings', () => {
      tenderly = new TenderlyIntegration({
        accessKey: '',
        accountSlug: '',
        projectSlug: '',
      });
      expect(tenderly.isConfigured()).toBe(false);
    });
  });

  describe('formatCallTrace', () => {
    it('should format a simple call trace', () => {
      tenderly = new TenderlyIntegration();

      const nodes: TenderlyCallNode[] = [
        {
          type: 'CALL',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          value: '0',
          gasUsed: 50000,
          input: '0xa9059cbb',
          output: '0x01',
        },
      ];

      const formatted = tenderly.formatCallTrace(nodes);

      expect(formatted).toContain('CALL');
      expect(formatted).toContain('0x1111...1111');
      expect(formatted).toContain('0x2222...2222');
      expect(formatted).toContain('gas');
    });

    it('should format nested call traces with indentation', () => {
      tenderly = new TenderlyIntegration();

      const nodes: TenderlyCallNode[] = [
        {
          type: 'CALL',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          value: '0',
          gasUsed: 100000,
          input: '0x12345678',
          output: '0x',
          calls: [
            {
              type: 'DELEGATECALL',
              from: '0x2222222222222222222222222222222222222222',
              to: '0x3333333333333333333333333333333333333333',
              value: '0',
              gasUsed: 50000,
              input: '0xabcdef01',
              output: '0x',
            },
          ],
        },
      ];

      const formatted = tenderly.formatCallTrace(nodes);
      expect(formatted).toContain('CALL');
      expect(formatted).toContain('DELEGATECALL');
      // The nested call should be indented
      const lines = formatted.split('\n');
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should include decoded function info when available', () => {
      tenderly = new TenderlyIntegration();

      const nodes: TenderlyCallNode[] = [
        {
          type: 'CALL',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          value: '0',
          gasUsed: 50000,
          input: '0xa9059cbb',
          output: '0x',
          decodedInput: {
            name: 'transfer',
            args: [
              { name: 'to', type: 'address', value: '0x3333' },
              { name: 'amount', type: 'uint256', value: '1000' },
            ],
          },
        },
      ];

      const formatted = tenderly.formatCallTrace(nodes);
      expect(formatted).toContain('transfer');
      expect(formatted).toContain('to: 0x3333');
      expect(formatted).toContain('amount: 1000');
    });

    it('should show error when present', () => {
      tenderly = new TenderlyIntegration();

      const nodes: TenderlyCallNode[] = [
        {
          type: 'CALL',
          from: '0x1111111111111111111111111111111111111111',
          to: '0x2222222222222222222222222222222222222222',
          value: '0',
          gasUsed: 0,
          input: '0x',
          output: '0x',
          error: 'execution reverted',
        },
      ];

      const formatted = tenderly.formatCallTrace(nodes);
      expect(formatted).toContain('execution reverted');
    });
  });

  describe('traceTransaction', () => {
    it('should fetch and parse transaction trace', async () => {
      tenderly = new TenderlyIntegration();

      mockHttpsResponse({
        transaction: {
          status: true,
          gas_used: 50000,
          call_trace: {
            type: 'CALL',
            from: '0xaaa',
            to: '0xbbb',
            value: '0',
            gas_used: 50000,
            input: '0x',
            output: '0x',
          },
          state_diff: [],
          logs: [],
        },
      });

      const trace = await tenderly.traceTransaction('0xhash', 'ethereum');

      expect(trace).toBeDefined();
      expect(trace!.hash).toBe('0xhash');
      expect(trace!.chain).toBe('ethereum');
      expect(trace!.gasUsed).toBe(50000);
    });

    it('should return null for unknown chain', async () => {
      tenderly = new TenderlyIntegration();
      const trace = await tenderly.traceTransaction('0xhash', 'unknownchain');
      expect(trace).toBeNull();
    });

    it('should cache traces for same transaction', async () => {
      tenderly = new TenderlyIntegration();

      mockHttpsResponse({
        transaction: {
          status: true,
          gas_used: 50000,
          call_trace: null,
          state_diff: [],
          logs: [],
        },
      });

      await tenderly.traceTransaction('0xhash', 'ethereum');
      await tenderly.traceTransaction('0xhash', 'ethereum');

      // Should only make one HTTP request
      expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('should return null on HTTP error', async () => {
      tenderly = new TenderlyIntegration();

      mockHttpsResponse(null, 500);

      const trace = await tenderly.traceTransaction('0xhash', 'ethereum');
      expect(trace).toBeNull();
    });
  });

  describe('generateReport', () => {
    it('should produce markdown report from trace', () => {
      tenderly = new TenderlyIntegration();

      const trace: TenderlyTrace = {
        hash: '0xabcdef',
        chain: 'ethereum',
        status: true,
        gasUsed: 150000,
        callTrace: [
          {
            type: 'CALL',
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            value: '0',
            gasUsed: 150000,
            input: '0x',
            output: '0x',
          },
        ],
        stateDiff: [
          {
            address: '0x2222222222222222222222222222222222222222',
            original: { '0x0': '0x1' },
            dirty: { '0x0': '0x2' },
          },
        ],
        logs: [
          {
            address: '0x2222222222222222222222222222222222222222',
            name: 'Transfer',
            inputs: [
              { name: 'from', type: 'address', value: '0x1111' },
              { name: 'to', type: 'address', value: '0x3333' },
            ],
            raw: { topics: ['0xddf252ad'], data: '0x' },
          },
        ],
      };

      const report = tenderly.generateReport(trace);

      expect(report).toContain('# Transaction Trace Report');
      expect(report).toContain('0xabcdef');
      expect(report).toContain('ethereum');
      expect(report).toContain('Success');
      expect(report).toContain('## Call Trace');
      expect(report).toContain('## State Changes');
      expect(report).toContain('## Event Logs');
      expect(report).toContain('Transfer');
      expect(report).toContain('0xTools Tenderly integration');
    });

    it('should show Reverted status for failed transactions', () => {
      tenderly = new TenderlyIntegration();

      const trace: TenderlyTrace = {
        hash: '0xfailed',
        chain: 'ethereum',
        status: false,
        gasUsed: 21000,
        callTrace: [],
        stateDiff: [],
        logs: [],
      };

      const report = tenderly.generateReport(trace);
      expect(report).toContain('Reverted');
    });

    it('should include gas breakdown when multiple contracts involved', () => {
      tenderly = new TenderlyIntegration();

      const trace: TenderlyTrace = {
        hash: '0xmulti',
        chain: 'ethereum',
        status: true,
        gasUsed: 200000,
        callTrace: [
          {
            type: 'CALL',
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            value: '0',
            gasUsed: 120000,
            input: '0x',
            output: '0x',
            calls: [
              {
                type: 'CALL',
                from: '0x2222222222222222222222222222222222222222',
                to: '0x3333333333333333333333333333333333333333',
                value: '0',
                gasUsed: 80000,
                input: '0x',
                output: '0x',
              },
            ],
          },
        ],
        stateDiff: [],
        logs: [],
      };

      const report = tenderly.generateReport(trace);
      expect(report).toContain('Gas Breakdown');
    });
  });

  describe('simulate', () => {
    it('should return null when not configured', async () => {
      tenderly = new TenderlyIntegration();
      const result = await tenderly.simulate({
        chain: 'ethereum',
        from: '0x1111',
        to: '0x2222',
        input: '0xa9059cbb',
      });
      expect(result).toBeNull();
    });

    it('should return null for unknown chain', async () => {
      tenderly = new TenderlyIntegration({
        accessKey: 'key',
        accountSlug: 'account',
        projectSlug: 'project',
      });

      const result = await tenderly.simulate({
        chain: 'unknownchain',
        from: '0x1111',
        to: '0x2222',
        input: '0x',
      });
      expect(result).toBeNull();
    });
  });
});
