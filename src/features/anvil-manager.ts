/**
 * Anvil Manager -- Local Anvil Node Manager
 *
 * Manages a local Anvil (Foundry's local EVM node) instance.
 * Supports forking, state snapshots, time manipulation,
 * account impersonation, and other Anvil-specific RPC methods.
 *
 * Degrades gracefully when anvil is not installed.
 */

import { ChildProcess, execFile, spawn } from 'child_process';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnvilConfig {
  port?: number;
  forkUrl?: string;
  forkBlockNumber?: number;
  accounts?: number;
  balance?: number;
  blockTime?: number;
  chainId?: number;
  gasLimit?: number;
  gasPrice?: number;
  silent?: boolean;
}

export interface AnvilAccount {
  address: string;
  privateKey: string;
  balance: string;
}

export interface AnvilState {
  running: boolean;
  pid?: number;
  port: number;
  rpcUrl: string;
  chainId: number;
  forkUrl?: string;
  forkBlockNumber?: number;
  accounts: AnvilAccount[];
  blockNumber: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 8545;
const DEFAULT_ACCOUNTS = 10;
const DEFAULT_BALANCE = 10000;
const STARTUP_TIMEOUT = 15_000;
const RPC_TIMEOUT = 3_000; // localhost Anvil — no network hop
const OUTPUT_BUFFER_LIMIT = 64 * 1024;

// Pre-compiled regexes for account parsing (used once at startup)
const ADDR_REGEX = /\((\d+)\)\s+(0x[0-9a-fA-F]{40})\s+\(([^)]+)\)/g;
const KEY_REGEX = /\((\d+)\)\s+(0x[0-9a-fA-F]{64})/g;

// ---------------------------------------------------------------------------
// AnvilManager
// ---------------------------------------------------------------------------

export class AnvilManager {
  private process: ChildProcess | null = null;
  private config: AnvilConfig = {};
  private accounts: AnvilAccount[] = [];
  private port: number = DEFAULT_PORT;
  private outputBuffer = '';
  private chainId = 31337;
  private _available: boolean | null = null;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}

  // ─── Availability ─────────────────────────────────────────────────────

  /** Check if anvil is installed (cached after first check) */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) {
      return this._available;
    }
    return new Promise((resolve) => {
      execFile('anvil', ['--version'], { timeout: 5_000 }, (err) => {
        this._available = !err;
        resolve(this._available);
      });
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Start a new Anvil instance */
  async start(config?: AnvilConfig): Promise<AnvilState> {
    if (this.process) {
      await this.stop();
    }

    this.config = config || {};
    this.port = this.config.port || DEFAULT_PORT;
    this.chainId = this.config.chainId || 31337;
    this.outputBuffer = '';
    this.accounts = [];

    const args = this.buildArgs();

    return new Promise((resolve, reject) => {
      const proc = spawn('anvil', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = proc;

      let startupOutput = '';
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Even if we timed out on parsing, Anvil may still be running.
          // Attempt to build state from whatever output we have.
          this.parseAccounts(startupOutput);
          resolve(this.buildState());
        }
      }, STARTUP_TIMEOUT);

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        startupOutput += text;
        this.appendOutput(text);

        // Anvil prints "Listening on 0.0.0.0:PORT" when ready
        if (!resolved && startupOutput.includes('Listening on')) {
          resolved = true;
          clearTimeout(timer);
          this.parseAccounts(startupOutput);
          resolve(this.buildState());
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        startupOutput += text;
        this.appendOutput(text);
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`Failed to start anvil: ${err.message}`));
        }
      });

      proc.on('exit', (code) => {
        this.process = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error(`anvil exited with code ${code} before becoming ready`));
        }
      });
    });
  }

  /** Stop the running Anvil instance */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    const proc = this.process;
    this.process = null;

    return new Promise((resolve) => {
      proc.on('exit', () => resolve());
      proc.kill('SIGTERM');

      // Force kill after 5 seconds if SIGTERM didn't work
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already dead
        }
        resolve();
      }, 5_000);
    });
  }

  /** Check if Anvil is currently running */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /** Get current state */
  getState(): AnvilState | null {
    if (!this.isRunning()) {
      return null;
    }
    return this.buildState();
  }

  /** Get the RPC URL for the running instance */
  getRpcUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Get funded test accounts */
  getAccounts(): AnvilAccount[] {
    return [...this.accounts];
  }

  // ─── State Manipulation (via JSON-RPC) ────────────────────────────────

  /** Mine a block (anvil_mine) */
  async mine(blocks?: number): Promise<void> {
    await this.rpc('anvil_mine', [blocks || 1]);
  }

  /** Set next block timestamp (evm_setNextBlockTimestamp) */
  async setNextBlockTimestamp(timestamp: number): Promise<void> {
    await this.rpc('evm_setNextBlockTimestamp', [timestamp]);
  }

  /** Increase time (evm_increaseTime) */
  async increaseTime(seconds: number): Promise<void> {
    await this.rpc('evm_increaseTime', [seconds]);
  }

  /** Take a state snapshot (evm_snapshot) */
  async snapshot(): Promise<string> {
    const result = await this.rpc('evm_snapshot', []);
    return String(result);
  }

  /** Revert to a snapshot (evm_revert) */
  async revert(snapshotId: string): Promise<boolean> {
    const result = await this.rpc('evm_revert', [snapshotId]);
    return Boolean(result);
  }

  /** Impersonate an account (anvil_impersonateAccount) */
  async impersonate(address: string): Promise<void> {
    await this.rpc('anvil_impersonateAccount', [address]);
  }

  /** Stop impersonating (anvil_stopImpersonatingAccount) */
  async stopImpersonating(address: string): Promise<void> {
    await this.rpc('anvil_stopImpersonatingAccount', [address]);
  }

  /** Set balance for an address (anvil_setBalance) */
  async setBalance(address: string, balanceInWei: string): Promise<void> {
    // balanceInWei should be a hex string; convert if decimal
    const hexBalance = balanceInWei.startsWith('0x')
      ? balanceInWei
      : '0x' + BigInt(balanceInWei).toString(16);
    await this.rpc('anvil_setBalance', [address, hexBalance]);
  }

  /** Set storage at slot (anvil_setStorageAt) */
  async setStorageAt(address: string, slot: string, value: string): Promise<void> {
    await this.rpc('anvil_setStorageAt', [address, slot, value]);
  }

  /** Reset fork to a specific block */
  async reset(options?: { forkUrl?: string; forkBlockNumber?: number }): Promise<void> {
    const params: Record<string, unknown> = {};
    if (options?.forkUrl) {
      params.forking = {
        jsonRpcUrl: options.forkUrl,
        blockNumber: options.forkBlockNumber,
      };
    }
    await this.rpc('anvil_reset', [params]);
  }

  /** Get recent Anvil output/logs */
  getOutput(): string {
    return this.outputBuffer;
  }

  /** Generate markdown report of current state */
  generateReport(): string {
    if (!this.isRunning()) {
      return '## Anvil Status\n\nNot running.\n';
    }

    const lines: string[] = [
      '## Anvil Local Node',
      '',
      `- **Status:** Running (PID ${this.process?.pid || 'unknown'})`,
      `- **RPC URL:** ${this.getRpcUrl()}`,
      `- **Chain ID:** ${this.chainId}`,
      `- **Port:** ${this.port}`,
    ];

    if (this.config.forkUrl) {
      lines.push(`- **Fork URL:** ${this.config.forkUrl}`);
      if (this.config.forkBlockNumber !== undefined) {
        lines.push(`- **Fork Block:** ${this.config.forkBlockNumber}`);
      }
    }

    if (this.config.blockTime !== undefined) {
      lines.push(`- **Block Time:** ${this.config.blockTime}s`);
    }

    if (this.accounts.length > 0) {
      lines.push('', '### Accounts', '');
      lines.push('| # | Address | Private Key (first 10 chars) |');
      lines.push('|---|---------|------------------------------|');
      this.accounts.forEach((acc, i) => {
        const keyPreview = acc.privateKey.substring(0, 12) + '...';
        lines.push(`| ${i} | \`${acc.address}\` | \`${keyPreview}\` |`);
      });
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Build CLI args from config.
   */
  private buildArgs(): string[] {
    const args: string[] = [];
    const c = this.config;

    if (c.port !== undefined) {
      args.push('--port', String(c.port));
    }
    if (c.forkUrl) {
      args.push('--fork-url', c.forkUrl);
    }
    if (c.forkBlockNumber !== undefined) {
      args.push('--fork-block-number', String(c.forkBlockNumber));
    }
    if (c.accounts !== undefined) {
      args.push('--accounts', String(c.accounts));
    } else {
      args.push('--accounts', String(DEFAULT_ACCOUNTS));
    }
    if (c.balance !== undefined) {
      args.push('--balance', String(c.balance));
    } else {
      args.push('--balance', String(DEFAULT_BALANCE));
    }
    if (c.blockTime !== undefined) {
      args.push('--block-time', String(c.blockTime));
    }
    if (c.chainId !== undefined) {
      args.push('--chain-id', String(c.chainId));
    }
    if (c.gasLimit !== undefined) {
      args.push('--gas-limit', String(c.gasLimit));
    }
    if (c.gasPrice !== undefined) {
      args.push('--gas-price', String(c.gasPrice));
    }
    if (c.silent) {
      args.push('--silent');
    }

    return args;
  }

  /**
   * Parse accounts and private keys from Anvil startup output.
   *
   * Anvil prints:
   *   Available Accounts
   *   ==================
   *   (0) 0x... (10000.000 ETH)
   *   ...
   *
   *   Private Keys
   *   ==================
   *   (0) 0x...
   *   ...
   */
  private parseAccounts(output: string): void {
    this.accounts = [];

    const addresses: string[] = [];
    const keys: string[] = [];

    // Parse addresses
    const accountsSection = output.split('Private Keys')[0] || '';
    ADDR_REGEX.lastIndex = 0;
    let match;
    while ((match = ADDR_REGEX.exec(accountsSection)) !== null) {
      addresses.push(match[2]);
    }

    // Parse private keys
    const keysSection = output.split('Private Keys')[1] || '';
    KEY_REGEX.lastIndex = 0;
    while ((match = KEY_REGEX.exec(keysSection)) !== null) {
      keys.push(match[2]);
    }

    const balance = String(this.config.balance || DEFAULT_BALANCE);

    for (let i = 0; i < Math.min(addresses.length, keys.length); i++) {
      this.accounts.push({
        address: addresses[i],
        privateKey: keys[i],
        balance,
      });
    }
  }

  /**
   * Append text to the rolling output buffer, trimming if too large.
   */
  private appendOutput(text: string): void {
    this.outputBuffer += text;
    if (this.outputBuffer.length > OUTPUT_BUFFER_LIMIT) {
      this.outputBuffer = this.outputBuffer.substring(
        this.outputBuffer.length - OUTPUT_BUFFER_LIMIT
      );
    }
  }

  /**
   * Build an AnvilState snapshot.
   */
  private buildState(): AnvilState {
    return {
      running: this.isRunning(),
      pid: this.process?.pid,
      port: this.port,
      rpcUrl: this.getRpcUrl(),
      chainId: this.chainId,
      forkUrl: this.config.forkUrl,
      forkBlockNumber: this.config.forkBlockNumber,
      accounts: [...this.accounts],
      blockNumber: 0, // will be populated by next query if needed
    };
  }

  /**
   * Send a JSON-RPC request to the local Anvil instance.
   */
  private rpc(method: string, params: unknown[]): Promise<unknown> {
    if (!this.isRunning()) {
      return Promise.reject(new Error('Anvil is not running'));
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: RPC_TIMEOUT,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                reject(
                  new Error(
                    `RPC error (${method}): ${parsed.error.message || JSON.stringify(parsed.error)}`
                  )
                );
              } else {
                resolve(parsed.result);
              }
            } catch (e) {
              reject(new Error(`Failed to parse RPC response for ${method}: ${data}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(new Error(`RPC request failed (${method}): ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`RPC request timed out (${method})`));
      });

      req.write(body);
      req.end();
    });
  }
}
