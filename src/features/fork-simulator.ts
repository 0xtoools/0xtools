/**
 * Fork Simulator — Chain fork testing via Anvil
 *
 * Orchestrates a local Anvil fork of any EVM chain, providing
 * transaction simulation, contract deployment, state manipulation,
 * time-warping, and snapshot/revert capabilities via JSON-RPC.
 *
 * Uses `child_process.spawn` for the Anvil process and Node's
 * built-in `http` module for JSON-RPC calls to the local endpoint.
 *
 * Standalone — no VS Code dependency required.
 */

import { spawn, execFile, ChildProcess } from 'child_process';
import * as http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForkConfig {
  chain: string;
  rpcUrl?: string;
  blockNumber?: number;
  port?: number;
  accounts?: number;
  balance?: number;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: number;
  returnData: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
  stateChanges?: Array<{
    address: string;
    slot: string;
    before: string;
    after: string;
  }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const SIMULATION_TIMEOUT_MS = 300_000;

/** Default public RPC endpoints for chain forks. */
const DEFAULT_RPC_URLS: Record<string, string> = {
  ethereum: 'https://eth.llamarpc.com',
  mainnet: 'https://eth.llamarpc.com',
  polygon: 'https://polygon-rpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  base: 'https://mainnet.base.org',
  bsc: 'https://bsc-dataseed1.binance.org',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  sepolia: 'https://rpc.sepolia.org',
};

// ---------------------------------------------------------------------------
// ForkSimulator
// ---------------------------------------------------------------------------

export class ForkSimulator {
  private anvilProcess: ChildProcess | null;
  private rpcUrl: string;
  private running: boolean;
  private defaultAccount: string;
  private _available: boolean | null;

  constructor() {
    this.anvilProcess = null;
    this.rpcUrl = '';
    this.running = false;
    this.defaultAccount = '';
    this._available = null;
  }

  /**
   * Check if Anvil (from Foundry) is available on PATH (cached after first check).
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) {
      return this._available;
    }
    return new Promise((resolve) => {
      execFile('anvil', ['--version'], { timeout: COMMAND_TIMEOUT_MS }, (err) => {
        this._available = !err;
        resolve(this._available);
      });
    });
  }

  /**
   * Start a forked Anvil instance.
   *
   * @param config - Fork configuration
   * @returns RPC URL, test accounts, and forked block number
   */
  async startFork(
    config: ForkConfig
  ): Promise<{
    rpcUrl: string;
    accounts: Array<{ address: string; privateKey: string }>;
    forkBlock: number;
  }> {
    if (this.running) {
      await this.stopFork();
    }

    const forkUrl = config.rpcUrl || DEFAULT_RPC_URLS[config.chain.toLowerCase()];
    if (!forkUrl) {
      throw new Error(`No RPC URL available for chain "${config.chain}". Provide a custom rpcUrl.`);
    }

    const port = config.port || 8545;
    const accountCount = config.accounts || 10;
    const balance = config.balance || 10000;

    const args = [
      '--fork-url',
      forkUrl,
      '--port',
      String(port),
      '--accounts',
      String(accountCount),
      '--balance',
      String(balance),
      '--no-mining', // manual mining for deterministic tests
    ];

    if (config.blockNumber !== undefined) {
      args.push('--fork-block-number', String(config.blockNumber));
    }

    // Remove --no-mining: let anvil auto-mine for simplicity
    const nmIdx = args.indexOf('--no-mining');
    if (nmIdx !== -1) {
      args.splice(nmIdx, 1);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('anvil', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.anvilProcess = proc;
      this.rpcUrl = `http://127.0.0.1:${port}`;

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Anvil might be running even without matching output
          this.running = true;
          this.tryResolveStart(port, config, resolve, reject);
        }
      }, 15_000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();

        // Anvil prints "Listening on 127.0.0.1:PORT" when ready
        if (!resolved && stdout.includes('Listening on')) {
          resolved = true;
          clearTimeout(timeout);
          this.running = true;
          this.extractAccountsAndResolve(stdout, port, config, resolve, reject);
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start anvil: ${err.message}`));
        }
      });

      proc.on('exit', (code) => {
        this.running = false;
        this.anvilProcess = null;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Anvil exited with code ${code}: ${stderr}`));
        }
      });
    });
  }

  /**
   * Stop the forked Anvil instance.
   */
  async stopFork(): Promise<void> {
    if (this.anvilProcess) {
      this.anvilProcess.kill('SIGTERM');
      // Give it a moment to shut down
      await new Promise<void>((resolve) => {
        const proc = this.anvilProcess;
        if (!proc) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 5000);
        proc.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.anvilProcess = null;
    }
    this.running = false;
    this.rpcUrl = '';
    this.defaultAccount = '';
  }

  /** Check if the fork is running. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Simulate a transaction on the fork using eth_call (read-only, no state change).
   */
  async simulate(options: {
    from?: string;
    to: string;
    data: string;
    value?: string;
  }): Promise<SimulationResult> {
    this.assertRunning();

    const from = options.from || this.defaultAccount;
    const txObj: Record<string, string> = {
      from,
      to: options.to,
      data: options.data,
    };
    if (options.value) {
      txObj.value = options.value;
    }

    try {
      // Use eth_call for simulation (no state mutation)
      const callResult = await this.rpcCall('eth_call', [txObj, 'latest']);
      const returnData = typeof callResult === 'string' ? callResult : '0x';

      // Also estimate gas
      let gasUsed = 0;
      try {
        const gasResult = await this.rpcCall('eth_estimateGas', [txObj]);
        gasUsed = typeof gasResult === 'string' ? parseInt(gasResult, 16) : 0;
      } catch {
        // gas estimation can fail for reverts
      }

      return {
        success: true,
        gasUsed,
        returnData,
        logs: [],
      };
    } catch (err: any) {
      return {
        success: false,
        gasUsed: 0,
        returnData: '0x',
        logs: [],
        error: err.message || String(err),
      };
    }
  }

  /**
   * Simulate a contract deployment on the fork.
   */
  async simulateDeploy(options: {
    from?: string;
    bytecode: string;
    constructorArgs?: string;
    value?: string;
  }): Promise<SimulationResult & { contractAddress?: string }> {
    this.assertRunning();

    const from = options.from || this.defaultAccount;
    const data = options.constructorArgs
      ? options.bytecode + options.constructorArgs.replace(/^0x/, '')
      : options.bytecode;

    const txObj: Record<string, string> = {
      from,
      data,
    };
    if (options.value) {
      txObj.value = options.value;
    }

    try {
      // Send actual transaction for deployment (needs state change)
      const txHash = await this.rpcCall('eth_sendTransaction', [txObj]);
      if (typeof txHash !== 'string') {
        return {
          success: false,
          gasUsed: 0,
          returnData: '0x',
          logs: [],
          error: 'No tx hash returned',
        };
      }

      // Get receipt
      const receipt = await this.waitForReceipt(txHash);
      if (!receipt) {
        return {
          success: false,
          gasUsed: 0,
          returnData: '0x',
          logs: [],
          error: 'Receipt not found',
        };
      }

      const gasUsed = typeof receipt.gasUsed === 'string' ? parseInt(receipt.gasUsed, 16) : 0;
      const status = receipt.status === '0x1' || receipt.status === true;
      const contractAddress = receipt.contractAddress || undefined;
      const logs = this.parseReceiptLogs(receipt.logs || []);

      return {
        success: status,
        gasUsed,
        returnData: '0x',
        logs,
        contractAddress,
        error: status ? undefined : 'Deployment reverted',
      };
    } catch (err: any) {
      return {
        success: false,
        gasUsed: 0,
        returnData: '0x',
        logs: [],
        error: err.message || String(err),
      };
    }
  }

  /**
   * Run a series of transactions in sequence on the fork.
   * Each transaction mutates state, so order matters.
   */
  async simulateSequence(
    txns: Array<{
      from?: string;
      to: string;
      data: string;
      value?: string;
      label?: string;
    }>
  ): Promise<Array<SimulationResult & { label?: string }>> {
    this.assertRunning();
    const results: Array<SimulationResult & { label?: string }> = [];

    for (const txn of txns) {
      const from = txn.from || this.defaultAccount;
      const txObj: Record<string, string> = {
        from,
        to: txn.to,
        data: txn.data,
      };
      if (txn.value) {
        txObj.value = txn.value;
      }

      try {
        const txHash = await this.rpcCall('eth_sendTransaction', [txObj]);
        if (typeof txHash !== 'string') {
          results.push({
            success: false,
            gasUsed: 0,
            returnData: '0x',
            logs: [],
            error: 'No tx hash returned',
            label: txn.label,
          });
          continue;
        }

        const receipt = await this.waitForReceipt(txHash);
        if (!receipt) {
          results.push({
            success: false,
            gasUsed: 0,
            returnData: '0x',
            logs: [],
            error: 'Receipt not found',
            label: txn.label,
          });
          continue;
        }

        const gasUsed = typeof receipt.gasUsed === 'string' ? parseInt(receipt.gasUsed, 16) : 0;
        const status = receipt.status === '0x1' || receipt.status === true;
        const logs = this.parseReceiptLogs(receipt.logs || []);

        results.push({
          success: status,
          gasUsed,
          returnData: '0x',
          logs,
          error: status ? undefined : 'Transaction reverted',
          label: txn.label,
        });
      } catch (err: any) {
        results.push({
          success: false,
          gasUsed: 0,
          returnData: '0x',
          logs: [],
          error: err.message || String(err),
          label: txn.label,
        });
      }
    }

    return results;
  }

  /**
   * Impersonate an address on the fork (unlock it for sending transactions).
   */
  async impersonate(address: string): Promise<void> {
    this.assertRunning();
    await this.rpcCall('anvil_impersonateAccount', [address]);
  }

  /**
   * Set a specific storage slot value at an address.
   */
  async setStorage(address: string, slot: string, value: string): Promise<void> {
    this.assertRunning();
    // Pad slot and value to 32 bytes (64 hex chars + 0x prefix)
    const paddedSlot = padHex(slot, 32);
    const paddedValue = padHex(value, 32);
    await this.rpcCall('anvil_setStorageAt', [address, paddedSlot, paddedValue]);
  }

  /**
   * Get the current block number on the fork.
   */
  async getBlockNumber(): Promise<number> {
    this.assertRunning();
    const result = await this.rpcCall('eth_blockNumber', []);
    return typeof result === 'string' ? parseInt(result, 16) : 0;
  }

  /**
   * Mine a specific number of blocks.
   */
  async mineBlocks(count: number): Promise<void> {
    this.assertRunning();
    await this.rpcCall('anvil_mine', [`0x${count.toString(16)}`]);
  }

  /**
   * Warp time forward by a number of seconds.
   */
  async warpTime(seconds: number): Promise<void> {
    this.assertRunning();
    await this.rpcCall('evm_increaseTime', [`0x${seconds.toString(16)}`]);
    // Mine one block to apply the time change
    await this.mineBlocks(1);
  }

  /**
   * Take an EVM snapshot and return its ID.
   */
  async snapshot(): Promise<string> {
    this.assertRunning();
    const result = await this.rpcCall('evm_snapshot', []);
    return typeof result === 'string' ? result : '0x0';
  }

  /**
   * Revert the EVM to a previous snapshot.
   */
  async revertSnapshot(id: string): Promise<void> {
    this.assertRunning();
    await this.rpcCall('evm_revert', [id]);
  }

  /**
   * Generate a markdown report from simulation results.
   */
  generateReport(results: SimulationResult[], config: ForkConfig): string {
    const lines: string[] = [
      '# Fork Simulation Report',
      '',
      '## Configuration',
      '',
      `| Setting | Value |`,
      `|---------|-------|`,
      `| Chain | ${config.chain} |`,
      `| RPC URL | ${config.rpcUrl || DEFAULT_RPC_URLS[config.chain.toLowerCase()] || 'N/A'} |`,
    ];

    if (config.blockNumber !== undefined) {
      lines.push(`| Fork Block | ${config.blockNumber} |`);
    }
    lines.push('');

    lines.push('## Results');
    lines.push('');

    let totalGas = 0;
    let successCount = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const label = (r as any).label || `Transaction ${i + 1}`;
      const statusIcon = r.success ? '[OK]' : '[FAIL]';

      lines.push(`### ${statusIcon} ${label}`);
      lines.push('');
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| Status | ${r.success ? 'Success' : 'Reverted'} |`);
      lines.push(`| Gas Used | ${formatGas(r.gasUsed)} |`);

      if (r.returnData && r.returnData !== '0x') {
        const truncated =
          r.returnData.length > 66
            ? `${r.returnData.substring(0, 34)}...${r.returnData.substring(r.returnData.length - 16)}`
            : r.returnData;
        lines.push(`| Return Data | \`${truncated}\` |`);
      }
      if (r.error) {
        lines.push(`| Error | ${r.error} |`);
      }
      if ((r as any).contractAddress) {
        lines.push(`| Contract | \`${(r as any).contractAddress}\` |`);
      }
      lines.push('');

      if (r.logs.length > 0) {
        lines.push(`**Events (${r.logs.length}):**`);
        for (const log of r.logs) {
          const addr = log.address ? `${log.address.substring(0, 8)}...` : 'unknown';
          lines.push(`- Log at \`${addr}\` (${log.topics.length} topics)`);
        }
        lines.push('');
      }

      totalGas += r.gasUsed;
      if (r.success) {
        successCount++;
      }
    }

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Transactions | ${results.length} |`);
    lines.push(`| Successful | ${successCount} |`);
    lines.push(`| Failed | ${results.length - successCount} |`);
    lines.push(`| Total Gas | ${formatGas(totalGas)} |`);
    lines.push('');
    lines.push('*Report generated by 0xTools Fork Simulator*');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertRunning(): void {
    if (!this.running) {
      throw new Error('Fork is not running. Call startFork() first.');
    }
  }

  /**
   * Make a JSON-RPC call to the local Anvil instance.
   */
  private rpcCall(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: Date.now(),
      });

      const url = new URL(this.rpcUrl);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 8545,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: RPC_TIMEOUT_MS,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer | string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              return;
            }
            resolve(parsed.result);
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => reject(new Error(`RPC error: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('RPC request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Wait for a transaction receipt, polling up to a timeout.
   */
  private async waitForReceipt(txHash: string, timeoutMs = 60_000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const receipt = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
        if (receipt) {
          return receipt;
        }
      } catch {
        // Not ready yet
      }
      // Small delay before retry
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }

  /**
   * Parse receipt logs into our log format.
   */
  private parseReceiptLogs(raw: any[]): SimulationResult['logs'] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((log: any) => ({
      address: log.address || '',
      topics: Array.isArray(log.topics) ? log.topics.map(String) : [],
      data: log.data || '0x',
    }));
  }

  /**
   * Extract accounts from Anvil stdout and resolve the startFork promise.
   */
  private extractAccountsAndResolve(
    stdout: string,
    port: number,
    config: ForkConfig,
    resolve: (value: any) => void,
    reject: (reason: any) => void
  ): void {
    const accounts = this.parseAnvilAccounts(stdout);
    this.defaultAccount = accounts.length > 0 ? accounts[0].address : '';

    // Try to get the fork block number
    this.getBlockNumber()
      .then((forkBlock) => {
        resolve({
          rpcUrl: `http://127.0.0.1:${port}`,
          accounts,
          forkBlock,
        });
      })
      .catch(() => {
        resolve({
          rpcUrl: `http://127.0.0.1:${port}`,
          accounts,
          forkBlock: config.blockNumber || 0,
        });
      });
  }

  /**
   * Fallback when Anvil output doesn't contain the expected "Listening" text.
   */
  private tryResolveStart(
    port: number,
    config: ForkConfig,
    resolve: (value: any) => void,
    reject: (reason: any) => void
  ): void {
    // Try to ping the RPC endpoint
    this.rpcCall('eth_blockNumber', [])
      .then((result) => {
        const blockNum = typeof result === 'string' ? parseInt(result, 16) : 0;
        this.defaultAccount = '';
        resolve({
          rpcUrl: `http://127.0.0.1:${port}`,
          accounts: [],
          forkBlock: blockNum,
        });
      })
      .catch(() => {
        reject(new Error('Anvil started but RPC is not responding'));
      });
  }

  /**
   * Parse Anvil's stdout to extract available accounts and private keys.
   */
  private parseAnvilAccounts(stdout: string): Array<{ address: string; privateKey: string }> {
    const accounts: Array<{ address: string; privateKey: string }> = [];

    // Anvil prints accounts like:
    //   Available Accounts
    //   ==================
    //   (0) 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000.000 ETH)
    //   ...
    //   Private Keys
    //   ==================
    //   (0) 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    //   ...

    const addresses: string[] = [];
    const keys: string[] = [];

    const addrRegex = /\((\d+)\)\s+(0x[a-fA-F0-9]{40})/g;
    const keyRegex = /\((\d+)\)\s+(0x[a-fA-F0-9]{64})/g;

    // Split into sections
    const accountSection = stdout.split('Private Keys')[0] || '';
    const keySection = stdout.split('Private Keys')[1] || '';

    let match;
    while ((match = addrRegex.exec(accountSection)) !== null) {
      addresses.push(match[2]);
    }
    while ((match = keyRegex.exec(keySection)) !== null) {
      keys.push(match[2]);
    }

    for (let i = 0; i < addresses.length; i++) {
      accounts.push({
        address: addresses[i],
        privateKey: keys[i] || '',
      });
    }

    return accounts;
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Pad a hex string to a given byte length (left-padded with zeros).
 */
function padHex(hex: string, bytes: number): string {
  const clean = hex.startsWith('0x') ? hex.substring(2) : hex;
  const padded = clean.padStart(bytes * 2, '0');
  return '0x' + padded;
}

/**
 * Format gas values for display.
 */
function formatGas(gas: number): string {
  if (gas >= 1_000_000) {
    return `${(gas / 1_000_000).toFixed(2)}M`;
  }
  if (gas >= 1_000) {
    return `${(gas / 1_000).toFixed(1)}k`;
  }
  return String(gas);
}
