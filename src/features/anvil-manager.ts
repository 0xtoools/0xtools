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
import { getAugmentedEnv } from './foundry-env';

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
  hardfork?: string;
  silent?: boolean;
}

export interface AnvilAccount {
  address: string;
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Does a PID still exist? Signal 0 performs an existence/permission check
 *  without actually delivering a signal. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  constructor() {}

  // ─── Availability ─────────────────────────────────────────────────────

  /**
   * Check if anvil is installed. A positive result is cached for the process
   * lifetime; negatives are NOT cached because the extension host may not have
   * inherited the user's shell PATH yet (the augmented env below addresses the
   * common case where anvil lives in ~/.foundry/bin).
   */
  async isAvailable(): Promise<boolean> {
    if (this._available === true) {
      return true;
    }
    return new Promise((resolve) => {
      execFile('anvil', ['--version'], { timeout: 5_000, env: getAugmentedEnv() }, (err) => {
        this._available = !err ? true : null;
        resolve(!err);
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

    // Make "Start Anvil" idempotent: a previous anvil (ours or one started
    // outside the extension, e.g. from a terminal) may still hold the port and
    // anvil can't bind a port that's in use. Free it before we spawn.
    await this.freePort(this.port);

    const args = this.buildArgs();

    return new Promise((resolve, reject) => {
      const proc = spawn('anvil', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: getAugmentedEnv(),
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

  /**
   * Terminate whatever is currently LISTENING on `port` so a fresh anvil can
   * bind it. Targets only the process(es) holding that exact port (most often a
   * stale anvil), SIGTERM then SIGKILL, and waits for the port to clear.
   * Best-effort: silently no-ops when it can't enumerate listeners (lsof
   * missing, or Windows), leaving the spawn to surface any bind error as before.
   */
  private async freePort(port: number): Promise<void> {
    const listeners = await this.listenersOnPort(port);
    const pids = listeners.map((l) => l.pid).filter((pid) => pid !== process.pid);
    if (pids.length === 0) {
      return;
    }
    for (const l of listeners) {
      this.appendOutput(`[0xtools] freeing port ${port} — stopping ${l.command} (pid ${l.pid})\n`);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone / not permitted */
      }
    }
    await delay(400);
    for (const pid of pids) {
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    await this.waitForPortFree(port, 3_000);
  }

  /** Enumerate processes LISTENING on a TCP port via `lsof`. Returns [] when
   *  lsof is unavailable or nothing is bound. */
  private listenersOnPort(port: number): Promise<Array<{ pid: number; command: string }>> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        resolve([]); // not supported here — fall back to the spawn bind error
        return;
      }
      execFile(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'],
        { timeout: 3_000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          // lsof -F pc emits one record per process: a `p<pid>` line followed
          // by a `c<command>` line.
          const out: Array<{ pid: number; command: string }> = [];
          let pid: number | null = null;
          for (const line of stdout.split('\n')) {
            if (line.startsWith('p')) {
              pid = parseInt(line.slice(1), 10);
            } else if (line.startsWith('c') && pid !== null) {
              out.push({ pid, command: line.slice(1) });
              pid = null;
            }
          }
          resolve(out.filter((r) => Number.isInteger(r.pid)));
        }
      );
    });
  }

  /** Poll until nothing is LISTENING on the port, or the timeout elapses. */
  private async waitForPortFree(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.listenersOnPort(port)).length === 0) {
        return;
      }
      await delay(150);
    }
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
      lines.push('| # | Address |');
      lines.push('|---|---------|');
      this.accounts.forEach((acc, i) => {
        lines.push(`| ${i} | \`${acc.address}\` |`);
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
    if (c.hardfork) {
      args.push('--hardfork', c.hardfork);
    }
    if (c.silent) {
      args.push('--silent');
    }

    return args;
  }

  /**
   * Parse account addresses from Anvil startup output.
   *
   * Anvil prints:
   *   Available Accounts
   *   ==================
   *   (0) 0x... (10000.000 ETH)
   *   ...
   */
  private parseAccounts(output: string): void {
    this.accounts = [];

    const addresses: string[] = [];

    // Parse addresses
    const accountsSection = output.split('Private Keys')[0] || '';
    ADDR_REGEX.lastIndex = 0;
    let match;
    while ((match = ADDR_REGEX.exec(accountsSection)) !== null) {
      addresses.push(match[2]);
    }

    // Anvil's stdout also prints the dev private keys below the addresses; we
    // deliberately never parse or retain them. Panel transactions sign on the
    // node itself (eth_sendTransaction against anvil's unlocked accounts).
    const balance = String(this.config.balance || DEFAULT_BALANCE);

    for (const address of addresses) {
      this.accounts.push({ address, balance });
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
