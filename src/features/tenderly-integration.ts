/**
 * Tenderly Integration — Transaction tracing and simulation
 *
 * Provides transaction tracing via Tenderly's public gateway and
 * authenticated simulation via the project API. Uses Node's built-in
 * `https` module for HTTP requests (no external dependencies).
 *
 * Standalone — no VS Code dependency required.
 */

import * as https from 'https';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenderlyConfig {
  accessKey?: string;
  accountSlug?: string;
  projectSlug?: string;
}

export interface TenderlyTrace {
  hash: string;
  chain: string;
  status: boolean;
  gasUsed: number;
  callTrace: TenderlyCallNode[];
  stateDiff: Array<{
    address: string;
    original: Record<string, string>;
    dirty: Record<string, string>;
  }>;
  logs: Array<{
    address: string;
    name?: string;
    inputs?: Array<{ name: string; type: string; value: string }>;
    raw: { topics: string[]; data: string };
  }>;
}

export interface TenderlyCallNode {
  type: string;
  from: string;
  to: string;
  value: string;
  gasUsed: number;
  input: string;
  output: string;
  decodedInput?: { name: string; args: Array<{ name: string; type: string; value: string }> };
  decodedOutput?: Array<{ name: string; type: string; value: string }>;
  error?: string;
  calls?: TenderlyCallNode[];
}

export interface TenderlySimulation {
  id: string;
  status: boolean;
  gasUsed: number;
  callTrace: TenderlyCallNode[];
  stateDiff: TenderlyTrace['stateDiff'];
  logs: TenderlyTrace['logs'];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 15_000;

const CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  mainnet: '1',
  sepolia: '11155111',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  base: '8453',
  bsc: '56',
  avalanche: '43114',
};

// ---------------------------------------------------------------------------
// TenderlyIntegration
// ---------------------------------------------------------------------------

export class TenderlyIntegration {
  private config: TenderlyConfig;
  private baseUrl: string;
  /** Cache for transaction traces keyed by "chain:txHash" (immutable data). */
  private traceCache: Map<string, TenderlyTrace>;

  constructor(config?: TenderlyConfig) {
    this.config = config || {};
    this.baseUrl = 'https://api.tenderly.co/api/v1';
    this.traceCache = new Map();
  }

  /** Check if Tenderly is configured with access key and project info. */
  isConfigured(): boolean {
    return !!(this.config.accessKey && this.config.accountSlug && this.config.projectSlug);
  }

  /**
   * Trace a transaction using Tenderly's public gateway.
   * No authentication needed for public transactions.
   *
   * @param txHash - Transaction hash (0x-prefixed)
   * @param chain  - Chain name (e.g. 'ethereum', 'polygon')
   * @returns Parsed trace or null on failure
   */
  async traceTransaction(txHash: string, chain: string): Promise<TenderlyTrace | null> {
    const chainId = CHAIN_IDS[chain.toLowerCase()];
    if (!chainId) {
      return null;
    }

    const normalizedHash = txHash.startsWith('0x') ? txHash : `0x${txHash}`;

    // Check cache — transaction traces are immutable
    const cacheKey = `${chain}:${normalizedHash}`;
    const cached = this.traceCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const path = `/public-contract/${chainId}/tx/${normalizedHash}`;

    try {
      const response = await this.httpGet(path);
      if (!response) {
        return null;
      }

      const trace = this.parseTraceResponse(response, normalizedHash, chain);
      if (trace) {
        this.traceCache.set(cacheKey, trace);
      }
      return trace;
    } catch {
      return null;
    }
  }

  /**
   * Simulate a transaction using Tenderly's authenticated API.
   * Requires accessKey, accountSlug, and projectSlug in config.
   *
   * @param options - Simulation parameters
   * @returns Simulation result or null on failure
   */
  async simulate(options: {
    chain: string;
    from: string;
    to: string;
    value?: string;
    input: string;
    gasLimit?: number;
    blockNumber?: number;
    stateOverrides?: Record<
      string,
      { balance?: string; nonce?: string; code?: string; storage?: Record<string, string> }
    >;
  }): Promise<TenderlySimulation | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const chainId = CHAIN_IDS[options.chain.toLowerCase()];
    if (!chainId) {
      return null;
    }

    const path = `/account/${this.config.accountSlug}/project/${this.config.projectSlug}/simulate`;

    const body: Record<string, unknown> = {
      network_id: chainId,
      from: options.from,
      to: options.to,
      input: options.input,
      value: options.value || '0',
      gas: options.gasLimit || 8_000_000,
      save: false,
      save_if_fails: false,
      simulation_type: 'full',
    };

    if (options.blockNumber !== undefined) {
      body.block_number = options.blockNumber;
    }

    if (options.stateOverrides) {
      const overrides: Record<string, Record<string, unknown>> = {};
      for (const [addr, state] of Object.entries(options.stateOverrides)) {
        const o: Record<string, unknown> = {};
        if (state.balance !== undefined) {
          o.balance = state.balance;
        }
        if (state.nonce !== undefined) {
          o.nonce = state.nonce;
        }
        if (state.code !== undefined) {
          o.code = state.code;
        }
        if (state.storage !== undefined) {
          o.stateDiff = state.storage;
        }
        overrides[addr] = o;
      }
      body.state_objects = overrides;
    }

    try {
      const response = await this.httpPost(path, body);
      if (!response) {
        return null;
      }

      return this.parseSimulationResponse(response);
    } catch {
      return null;
    }
  }

  /**
   * Format a call trace tree as indented human-readable text.
   *
   * @param nodes  - Array of call trace nodes
   * @param indent - Current indentation level (default 0)
   * @returns Formatted string
   */
  formatCallTrace(nodes: TenderlyCallNode[], indent = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);

    for (const node of nodes) {
      const toAddr = truncateAddress(node.to);
      const fromAddr = truncateAddress(node.from);
      const gasStr = node.gasUsed > 0 ? ` [${formatGas(node.gasUsed)} gas]` : '';
      const valueStr = node.value && node.value !== '0' ? ` {${node.value} wei}` : '';
      const errorStr = node.error ? ` !! ${node.error}` : '';

      let funcName = '';
      if (node.decodedInput) {
        const args = node.decodedInput.args.map((a) => `${a.name}: ${a.value}`).join(', ');
        funcName = `${node.decodedInput.name}(${args})`;
      } else if (node.input && node.input.length >= 10) {
        funcName = node.input.substring(0, 10);
      }

      lines.push(`${prefix}${node.type} ${fromAddr} -> ${toAddr}${valueStr}${gasStr}${errorStr}`);
      if (funcName) {
        lines.push(`${prefix}  fn: ${funcName}`);
      }

      if (node.decodedOutput && node.decodedOutput.length > 0) {
        const outStr = node.decodedOutput.map((o) => `${o.name}: ${o.value}`).join(', ');
        lines.push(`${prefix}  => ${outStr}`);
      }

      if (node.calls && node.calls.length > 0) {
        lines.push(this.formatCallTrace(node.calls, indent + 1));
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a detailed markdown report from a transaction trace.
   */
  generateReport(trace: TenderlyTrace): string {
    const lines: string[] = [
      '# Transaction Trace Report',
      '',
      '## Overview',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Hash | \`${trace.hash}\` |`,
      `| Chain | ${trace.chain} |`,
      `| Status | ${trace.status ? 'Success' : 'Reverted'} |`,
      `| Gas Used | ${formatGas(trace.gasUsed)} |`,
      '',
    ];

    // Call Trace
    if (trace.callTrace.length > 0) {
      lines.push('## Call Trace');
      lines.push('');
      lines.push('```');
      lines.push(this.formatCallTrace(trace.callTrace));
      lines.push('```');
      lines.push('');
    }

    // State Diff
    if (trace.stateDiff.length > 0) {
      lines.push('## State Changes');
      lines.push('');
      for (const diff of trace.stateDiff) {
        lines.push(`### \`${truncateAddress(diff.address)}\``);
        lines.push('');
        lines.push('| Slot | Before | After |');
        lines.push('|------|--------|-------|');
        const allSlots = new Set([...Object.keys(diff.original), ...Object.keys(diff.dirty)]);
        for (const slot of allSlots) {
          const before = diff.original[slot] || '(unset)';
          const after = diff.dirty[slot] || '(unset)';
          if (before !== after) {
            lines.push(
              `| \`${truncateHex(slot)}\` | \`${truncateHex(before)}\` | \`${truncateHex(after)}\` |`
            );
          }
        }
        lines.push('');
      }
    }

    // Logs
    if (trace.logs.length > 0) {
      lines.push('## Event Logs');
      lines.push('');
      for (let i = 0; i < trace.logs.length; i++) {
        const log = trace.logs[i];
        const name = log.name || 'Unknown Event';
        lines.push(`### ${i + 1}. ${name} at \`${truncateAddress(log.address)}\``);
        lines.push('');
        if (log.inputs && log.inputs.length > 0) {
          lines.push('| Parameter | Type | Value |');
          lines.push('|-----------|------|-------|');
          for (const input of log.inputs) {
            lines.push(`| ${input.name} | ${input.type} | \`${truncateHex(input.value)}\` |`);
          }
          lines.push('');
        } else {
          lines.push(`Topics: ${log.raw.topics.map((t) => `\`${truncateHex(t)}\``).join(', ')}`);
          lines.push('');
          if (log.raw.data && log.raw.data !== '0x') {
            lines.push(`Data: \`${truncateHex(log.raw.data)}\``);
            lines.push('');
          }
        }
      }
    }

    // Gas breakdown from call trace
    const gasBreakdown = this.collectGasBreakdown(trace.callTrace);
    if (gasBreakdown.length > 1) {
      lines.push('## Gas Breakdown by Contract');
      lines.push('');
      lines.push('| Contract | Gas Used | % |');
      lines.push('|----------|----------|---|');
      const total = trace.gasUsed || gasBreakdown.reduce((s, g) => s + g.gas, 0);
      for (const entry of gasBreakdown) {
        const pct = total > 0 ? ((entry.gas / total) * 100).toFixed(1) : '0';
        lines.push(`| \`${truncateAddress(entry.address)}\` | ${formatGas(entry.gas)} | ${pct}% |`);
      }
      lines.push('');
    }

    lines.push('');
    lines.push('*Report generated by 0xTools Tenderly integration*');

    return lines.join('\n');
  }

  /**
   * Generate a report for a simulation result.
   */
  generateSimulationReport(sim: TenderlySimulation): string {
    const lines: string[] = [
      '# Simulation Report',
      '',
      '## Overview',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Simulation ID | \`${sim.id}\` |`,
      `| Status | ${sim.status ? 'Success' : 'Reverted'} |`,
      `| Gas Used | ${formatGas(sim.gasUsed)} |`,
      '',
    ];

    if (sim.callTrace.length > 0) {
      lines.push('## Call Trace');
      lines.push('');
      lines.push('```');
      lines.push(this.formatCallTrace(sim.callTrace));
      lines.push('```');
      lines.push('');
    }

    if (sim.stateDiff.length > 0) {
      lines.push('## State Changes');
      lines.push('');
      for (const diff of sim.stateDiff) {
        lines.push(`### \`${truncateAddress(diff.address)}\``);
        lines.push('');
        lines.push('| Slot | Before | After |');
        lines.push('|------|--------|-------|');
        const allSlots = new Set([...Object.keys(diff.original), ...Object.keys(diff.dirty)]);
        for (const slot of allSlots) {
          const before = diff.original[slot] || '(unset)';
          const after = diff.dirty[slot] || '(unset)';
          if (before !== after) {
            lines.push(
              `| \`${truncateHex(slot)}\` | \`${truncateHex(before)}\` | \`${truncateHex(after)}\` |`
            );
          }
        }
        lines.push('');
      }
    }

    if (sim.logs.length > 0) {
      lines.push('## Event Logs');
      lines.push('');
      for (let i = 0; i < sim.logs.length; i++) {
        const log = sim.logs[i];
        const name = log.name || 'Unknown Event';
        lines.push(`**${i + 1}. ${name}** at \`${truncateAddress(log.address)}\``);
        if (log.inputs && log.inputs.length > 0) {
          for (const input of log.inputs) {
            lines.push(`  - ${input.name} (${input.type}): \`${truncateHex(input.value)}\``);
          }
        }
        lines.push('');
      }
    }

    lines.push('');
    lines.push('*Report generated by 0xTools Tenderly integration*');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Internal: HTTP helpers
  // -------------------------------------------------------------------------

  /**
   * Make an authenticated GET request to the Tenderly API.
   */
  private httpGet(apiPath: string): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const fullUrl = `${this.baseUrl}${apiPath}`;
      const url = new URL(fullUrl);

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.config.accessKey) {
        headers['X-Access-Key'] = this.config.accessKey;
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  /**
   * Make an authenticated POST request to the Tenderly API.
   */
  private httpPost(
    apiPath: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const fullUrl = `${this.baseUrl}${apiPath}`;
      const url = new URL(fullUrl);
      const bodyStr = JSON.stringify(body);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        Accept: 'application/json',
      };
      if (this.config.accessKey) {
        headers['X-Access-Key'] = this.config.accessKey;
      }

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(bodyStr);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // Internal: response parsers
  // -------------------------------------------------------------------------

  /**
   * Parse the public API trace response into a TenderlyTrace.
   */
  private parseTraceResponse(
    response: Record<string, unknown>,
    txHash: string,
    chain: string
  ): TenderlyTrace | null {
    try {
      // The public API may return the data in different shapes
      // depending on the endpoint version. Handle common cases.
      const txData = (response as any).transaction || (response as any).tx || response;

      const status =
        txData.status !== undefined
          ? Boolean(txData.status)
          : txData.receipt?.status !== undefined
            ? Boolean(txData.receipt.status)
            : true;

      const gasUsed =
        typeof txData.gas_used === 'number'
          ? txData.gas_used
          : typeof txData.receipt?.gasUsed === 'number'
            ? txData.receipt.gasUsed
            : typeof txData.receipt?.gas_used === 'number'
              ? txData.receipt.gas_used
              : 0;

      const callTrace = this.parseCallTraceNodes(txData.call_trace || txData.trace || null);
      const stateDiff = this.parseStateDiff(txData.state_diff || txData.stateDiff || []);
      const logs = this.parseLogs(txData.logs || txData.receipt?.logs || txData.decoded_logs || []);

      return {
        hash: txHash,
        chain,
        status,
        gasUsed,
        callTrace,
        stateDiff,
        logs,
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse the simulation API response into a TenderlySimulation.
   */
  private parseSimulationResponse(response: Record<string, unknown>): TenderlySimulation | null {
    try {
      const sim = (response as any).simulation || (response as any).transaction || response;

      const id = sim.id || sim.simulation_id || '';
      const status = sim.status !== undefined ? Boolean(sim.status) : true;
      const gasUsed =
        typeof sim.gas_used === 'number'
          ? sim.gas_used
          : typeof sim.receipt?.gas_used === 'number'
            ? sim.receipt.gas_used
            : 0;

      const callTrace = this.parseCallTraceNodes(
        sim.call_trace || sim.transaction?.call_trace || sim.trace || null
      );
      const stateDiff = this.parseStateDiff(sim.state_diff || sim.transaction?.state_diff || []);
      const logs = this.parseLogs(sim.logs || sim.transaction?.logs || sim.decoded_logs || []);

      return { id, status, gasUsed, callTrace, stateDiff, logs };
    } catch {
      return null;
    }
  }

  /**
   * Parse call trace nodes recursively from raw API response.
   */
  private parseCallTraceNodes(raw: unknown): TenderlyCallNode[] {
    if (!raw) {
      return [];
    }

    // If raw is a single node (the root call), wrap in array
    const nodes: unknown[] = Array.isArray(raw) ? raw : [raw];
    return nodes.map((node: any) => this.parseCallNode(node)).filter(Boolean) as TenderlyCallNode[];
  }

  private parseCallNode(node: any): TenderlyCallNode | null {
    if (!node || typeof node !== 'object') {
      return null;
    }

    const parsed: TenderlyCallNode = {
      type: node.call_type || node.type || 'CALL',
      from: node.from || '',
      to: node.to || '',
      value: String(node.value || '0'),
      gasUsed:
        typeof node.gas_used === 'number'
          ? node.gas_used
          : typeof node.gasUsed === 'number'
            ? node.gasUsed
            : 0,
      input: node.input || '',
      output: node.output || '',
    };

    // Decoded function info
    if (node.decoded_input || node.function_name) {
      const fnName = node.function_name || node.decoded_input?.method_name || '';
      const args: Array<{ name: string; type: string; value: string }> = [];
      if (Array.isArray(node.decoded_input?.parameters)) {
        for (const param of node.decoded_input.parameters) {
          args.push({
            name: param.soltype?.name || param.name || '',
            type: param.soltype?.type || param.type || '',
            value: String(param.value ?? ''),
          });
        }
      }
      if (fnName) {
        parsed.decodedInput = { name: fnName, args };
      }
    }

    // Decoded output
    if (Array.isArray(node.decoded_output)) {
      parsed.decodedOutput = node.decoded_output.map((o: any) => ({
        name: o.soltype?.name || o.name || '',
        type: o.soltype?.type || o.type || '',
        value: String(o.value ?? ''),
      }));
    }

    // Error
    if (node.error || node.error_reason) {
      parsed.error = node.error_reason || node.error || '';
    }

    // Nested calls
    if (Array.isArray(node.calls) && node.calls.length > 0) {
      parsed.calls = node.calls
        .map((c: any) => this.parseCallNode(c))
        .filter(Boolean) as TenderlyCallNode[];
    }

    return parsed;
  }

  /**
   * Parse state diff array from raw API response.
   */
  private parseStateDiff(raw: unknown[]): TenderlyTrace['stateDiff'] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((entry: any) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const address = entry.address || entry.contract || '';
        const original: Record<string, string> = {};
        const dirty: Record<string, string> = {};

        // Handle different formats
        if (entry.original && typeof entry.original === 'object') {
          Object.assign(original, entry.original);
        }
        if (entry.dirty && typeof entry.dirty === 'object') {
          Object.assign(dirty, entry.dirty);
        }

        // Alternative format: array of slot changes
        if (Array.isArray(entry.state_changes || entry.storage)) {
          for (const change of entry.state_changes || entry.storage) {
            if (change.key || change.slot) {
              const slot = change.key || change.slot;
              if (change.original !== undefined) {
                original[slot] = String(change.original);
              }
              if (change.dirty !== undefined || change.value !== undefined) {
                dirty[slot] = String(change.dirty ?? change.value);
              }
            }
          }
        }

        return { address, original, dirty };
      })
      .filter(Boolean) as TenderlyTrace['stateDiff'];
  }

  /**
   * Parse event logs from raw API response.
   */
  private parseLogs(raw: unknown[]): TenderlyTrace['logs'] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((log: any) => {
        if (!log || typeof log !== 'object') {
          return null;
        }

        const address = log.address || log.contract || '';
        const name = log.name || log.event_name || undefined;

        let inputs: Array<{ name: string; type: string; value: string }> | undefined;
        if (Array.isArray(log.inputs || log.decoded)) {
          inputs = (log.inputs || log.decoded).map((inp: any) => ({
            name: inp.soltype?.name || inp.name || '',
            type: inp.soltype?.type || inp.type || '',
            value: String(inp.value ?? ''),
          }));
        }

        const topics: string[] = Array.isArray(log.raw?.topics || log.topics)
          ? (log.raw?.topics || log.topics).map(String)
          : [];
        const data = log.raw?.data || log.data || '0x';

        return {
          address,
          name,
          inputs,
          raw: { topics, data },
        };
      })
      .filter(Boolean) as TenderlyTrace['logs'];
  }

  // -------------------------------------------------------------------------
  // Internal: gas breakdown collector
  // -------------------------------------------------------------------------

  /**
   * Collect gas usage per contract address from the call trace.
   */
  private collectGasBreakdown(nodes: TenderlyCallNode[]): Array<{ address: string; gas: number }> {
    const map = new Map<string, number>();

    const walk = (callNodes: TenderlyCallNode[]): void => {
      for (const node of callNodes) {
        const addr = node.to || node.from;
        if (addr && node.gasUsed > 0) {
          map.set(addr, (map.get(addr) || 0) + node.gasUsed);
        }
        if (node.calls) {
          walk(node.calls);
        }
      }
    };

    walk(nodes);

    return Array.from(map.entries())
      .map(([address, gas]) => ({ address, gas }))
      .sort((a, b) => b.gas - a.gas);
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function truncateAddress(addr: string): string {
  if (!addr || addr.length < 12) {
    return addr || '(empty)';
  }
  return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;
}

function truncateHex(hex: string): string {
  if (!hex || hex.length <= 18) {
    return hex || '';
  }
  return `${hex.substring(0, 10)}...${hex.substring(hex.length - 6)}`;
}

function formatGas(gas: number): string {
  if (gas >= 1_000_000) {
    return `${(gas / 1_000_000).toFixed(2)}M`;
  }
  if (gas >= 1_000) {
    return `${(gas / 1_000).toFixed(1)}k`;
  }
  return String(gas);
}
