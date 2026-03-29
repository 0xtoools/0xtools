/**
 * Foundry Cast CLI Integration
 *
 * Wraps the `cast` command-line tool for EVM interactions:
 * transaction simulation, ABI encoding/decoding, chain queries,
 * and various conversion utilities.
 *
 * All methods degrade gracefully when cast is not installed.
 */

import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CastResult {
  success: boolean;
  output: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 15_000;
const FAST_TIMEOUT = 5_000; // For local-only operations (keccak, sig, conversions)
const SEND_TIMEOUT = 120_000;
const MAX_BUFFER = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CastIntegration
// ---------------------------------------------------------------------------

export class CastIntegration {
  private castPath: string;
  private available: boolean | null = null;

  constructor(castPath?: string) {
    this.castPath = castPath || 'cast';
  }

  // ─── Availability ─────────────────────────────────────────────────────

  /** Check if cast is installed */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }
    try {
      await this.exec(['--version'], DEFAULT_TIMEOUT);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Get cast version */
  async getVersion(): Promise<string> {
    const result = await this.exec(['--version'], DEFAULT_TIMEOUT);
    return result.output.trim();
  }

  // ─── Transaction & Call ───────────────────────────────────────────────

  /** cast call -- simulate a contract call */
  async call(options: {
    to: string;
    functionSig: string;
    args?: string[];
    rpcUrl?: string;
    from?: string;
    block?: string | number;
  }): Promise<CastResult> {
    const args = ['call', options.to, options.functionSig];
    if (options.args) {
      args.push(...options.args);
    }
    if (options.rpcUrl) {
      args.push('--rpc-url', options.rpcUrl);
    }
    if (options.from) {
      args.push('--from', options.from);
    }
    if (options.block !== undefined) {
      args.push('--block', String(options.block));
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast send -- send a transaction (requires private key or keystore) */
  async send(options: {
    to: string;
    functionSig: string;
    args?: string[];
    rpcUrl: string;
    privateKey?: string;
    value?: string;
    gasLimit?: number;
  }): Promise<CastResult> {
    const args = ['send', options.to, options.functionSig];
    if (options.args) {
      args.push(...options.args);
    }
    args.push('--rpc-url', options.rpcUrl);
    if (options.privateKey) {
      args.push('--private-key', options.privateKey);
    }
    if (options.value) {
      args.push('--value', options.value);
    }
    if (options.gasLimit !== undefined) {
      args.push('--gas-limit', String(options.gasLimit));
    }
    return this.exec(args, SEND_TIMEOUT);
  }

  /** cast tx -- get transaction details */
  async tx(txHash: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['tx', txHash];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast receipt -- get transaction receipt */
  async receipt(txHash: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['receipt', txHash];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  // ─── ABI Encoding/Decoding ───────────────────────────────────────────

  /** cast abi-encode -- encode function args */
  async abiEncode(functionSig: string, args: string[]): Promise<CastResult> {
    return this.exec(['abi-encode', functionSig, ...args], FAST_TIMEOUT);
  }

  /** cast abi-decode -- decode ABI-encoded data */
  async abiDecode(types: string, data: string, input?: boolean): Promise<CastResult> {
    const args = ['abi-decode', types, data];
    if (input) {
      args.push('--input');
    }
    return this.exec(args, FAST_TIMEOUT);
  }

  /** cast calldata -- encode full calldata (selector + args) */
  async calldata(functionSig: string, args: string[]): Promise<CastResult> {
    return this.exec(['calldata', functionSig, ...args], FAST_TIMEOUT);
  }

  /** cast calldata-decode -- decode calldata */
  async calldataDecode(functionSig: string, data: string): Promise<CastResult> {
    return this.exec(['calldata-decode', functionSig, data], FAST_TIMEOUT);
  }

  /** cast 4byte -- lookup 4-byte selector */
  async fourByte(selector: string): Promise<CastResult> {
    return this.exec(['4byte', selector], DEFAULT_TIMEOUT);
  }

  /** cast 4byte-decode -- decode calldata using 4byte directory */
  async fourByteDecode(calldata: string): Promise<CastResult> {
    return this.exec(['4byte-decode', calldata], DEFAULT_TIMEOUT);
  }

  // ─── Chain Queries ────────────────────────────────────────────────────

  /** cast balance -- get ETH balance */
  async balance(address: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['balance', address];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast code -- get contract bytecode */
  async code(address: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['code', address];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast storage -- read storage slot */
  async storage(address: string, slot: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['storage', address, slot];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast block -- get block info */
  async block(blockNumber?: string | number, rpcUrl?: string): Promise<CastResult> {
    const args = ['block'];
    if (blockNumber !== undefined) {
      args.push(String(blockNumber));
    }
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast chain-id -- get chain ID */
  async chainId(rpcUrl?: string): Promise<CastResult> {
    const args = ['chain-id'];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast gas-price -- get current gas price */
  async gasPrice(rpcUrl?: string): Promise<CastResult> {
    const args = ['gas-price'];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** cast base-fee -- get current base fee */
  async baseFee(rpcUrl?: string): Promise<CastResult> {
    const args = ['base-fee'];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  // ─── Utility ──────────────────────────────────────────────────────────

  /** cast keccak -- hash data */
  async keccak(data: string): Promise<CastResult> {
    return this.exec(['keccak', data], FAST_TIMEOUT);
  }

  /** cast sig -- get function selector */
  async sig(functionSig: string): Promise<CastResult> {
    return this.exec(['sig', functionSig], FAST_TIMEOUT);
  }

  /** cast sig-event -- get event topic */
  async sigEvent(eventSig: string): Promise<CastResult> {
    return this.exec(['sig-event', eventSig], FAST_TIMEOUT);
  }

  /** cast to-wei -- convert to wei */
  async toWei(value: string, unit?: string): Promise<CastResult> {
    const args = ['to-wei', value];
    if (unit) {
      args.push(unit);
    }
    return this.exec(args, FAST_TIMEOUT);
  }

  /** cast from-wei -- convert from wei */
  async fromWei(value: string, unit?: string): Promise<CastResult> {
    const args = ['from-wei', value];
    if (unit) {
      args.push(unit);
    }
    return this.exec(args, FAST_TIMEOUT);
  }

  /** cast to-hex -- convert to hex */
  async toHex(value: string): Promise<CastResult> {
    return this.exec(['to-hex', value], FAST_TIMEOUT);
  }

  /** cast to-dec -- convert to decimal */
  async toDec(value: string): Promise<CastResult> {
    return this.exec(['to-dec', value], FAST_TIMEOUT);
  }

  /** cast to-ascii -- convert hex to ASCII */
  async toAscii(value: string): Promise<CastResult> {
    return this.exec(['to-ascii', value], FAST_TIMEOUT);
  }

  /** cast to-utf8 -- convert hex to UTF-8 */
  async toUtf8(value: string): Promise<CastResult> {
    return this.exec(['to-utf8', value], FAST_TIMEOUT);
  }

  /** cast to-checksum -- checksum an address */
  async toChecksum(address: string): Promise<CastResult> {
    return this.exec(['to-check-sum-address', address], FAST_TIMEOUT);
  }

  /** cast interface -- generate Solidity interface from ABI */
  async generateInterface(addressOrPath: string, rpcUrl?: string): Promise<CastResult> {
    const args = ['interface', addressOrPath];
    if (rpcUrl) {
      args.push('--rpc-url', rpcUrl);
    }
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  /** Run any cast command with raw args */
  async raw(args: string[]): Promise<CastResult> {
    return this.exec(args, DEFAULT_TIMEOUT);
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Execute a cast command and return a structured result.
   */
  private exec(args: string[], timeout: number): Promise<CastResult> {
    return new Promise((resolve) => {
      execFile(this.castPath, args, { timeout, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            success: false,
            output: stdout?.trim() || '',
            error: stderr?.trim() || err.message,
          });
          return;
        }
        resolve({
          success: true,
          output: stdout.trim(),
          error: stderr?.trim() || undefined,
        });
      });
    });
  }
}
