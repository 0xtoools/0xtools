/**
 * Forge Script Runner -- Run Foundry deployment/interaction scripts
 *
 * Wraps `forge script` to simulate or broadcast Solidity scripts.
 * Parses transaction output, gas usage, and broadcast logs.
 *
 * Degrades gracefully when forge is not installed.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScriptConfig {
  scriptPath: string;
  targetContract?: string;
  sig?: string;
  rpcUrl?: string;
  privateKey?: string;
  broadcast?: boolean;
  verify?: boolean;
  etherscanApiKey?: string;
  slow?: boolean;
  forkUrl?: string;
  verbosity?: number;
  gasEstimate?: number;
  legacy?: boolean;
  additionalArgs?: string[];
}

export interface ScriptTransaction {
  hash?: string;
  contractName?: string;
  contractAddress?: string;
  function?: string;
  type: 'create' | 'call';
  value?: string;
  gas?: number;
}

export interface ScriptResult {
  success: boolean;
  output: string;
  stderr: string;
  transactions?: ScriptTransaction[];
  gasUsed?: number;
  broadcastLog?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000;
const MAX_BUFFER = 8 * 1024 * 1024;

// Pre-compiled regexes for output parsing (called per script run)
const SUCCESS_PATTERN =
  /\[Success\]\s*Hash:\s*(0x[0-9a-fA-F]+)[\s\S]*?(?:Contract Address:\s*(0x[0-9a-fA-F]+))?[\s\S]*?(?:Gas used:\s*(\d+))?/g;
const CREATE_PATTERN = /\[CREATE\]\s+(\w+)@(0x[0-9a-fA-F]+)/g;
const NEW_CONTRACT_PATTERN = /contract\s+(\w+)\s+created\s+at:\s+(0x[0-9a-fA-F]+)\s+gas:\s+(\d+)/gi;
const TOTAL_GAS_PATTERN = /[Tt]otal\s+[Gg]as\s*(?:used)?[:\s]+(\d[\d,]*)/;
const GAS_LINE_PATTERN = /[Gg]as\s*(?:used)?[:\s]+(\d[\d,]*)/g;

// ---------------------------------------------------------------------------
// ForgeScriptRunner
// ---------------------------------------------------------------------------

export class ForgeScriptRunner {
  private _available: boolean | null = null;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}

  /** Check if forge is installed (cached after first check) */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) {
      return this._available;
    }
    return new Promise((resolve) => {
      execFile('forge', ['--version'], { timeout: 5_000 }, (err) => {
        this._available = !err;
        resolve(this._available);
      });
    });
  }

  /** Discover script files in the project */
  async discoverScripts(projectRoot: string): Promise<string[]> {
    const scripts: string[] = [];
    const scriptDir = path.join(projectRoot, 'script');

    if (!fs.existsSync(scriptDir)) {
      return scripts;
    }

    this.walkDir(scriptDir, (filePath) => {
      if (filePath.endsWith('.s.sol')) {
        scripts.push(filePath);
      }
    });

    return scripts.sort();
  }

  /** Run a forge script (simulation by default, broadcast if specified) */
  async run(config: ScriptConfig): Promise<ScriptResult> {
    const args = this.buildArgs(config);

    return new Promise((resolve) => {
      const timeout = config.broadcast ? DEFAULT_TIMEOUT * 2 : DEFAULT_TIMEOUT;

      execFile(
        'forge',
        ['script', ...args],
        {
          timeout,
          maxBuffer: MAX_BUFFER,
          cwd: this.findProjectRoot(config.scriptPath) || path.dirname(config.scriptPath),
        },
        (err, stdout, stderr) => {
          const output = stdout?.trim() || '';
          const stderrText = stderr?.trim() || '';

          if (err && !output) {
            resolve({
              success: false,
              output: '',
              stderr: stderrText || err.message,
            });
            return;
          }

          const transactions = this.parseTransactions(output);
          const gasUsed = this.parseGasUsed(output);
          const broadcastLog = this.findBroadcastLog(config);

          resolve({
            success: !err,
            output,
            stderr: stderrText,
            transactions,
            gasUsed,
            broadcastLog,
          });
        }
      );
    });
  }

  /** Dry run a script (simulate without broadcasting) */
  async dryRun(scriptPath: string, rpcUrl?: string): Promise<ScriptResult> {
    return this.run({
      scriptPath,
      rpcUrl,
      broadcast: false,
      verbosity: 3,
    });
  }

  /** Parse broadcast log to extract deployed contracts */
  parseBroadcastLog(logPath: string): Array<{
    hash: string;
    contractName?: string;
    contractAddress?: string;
    type: string;
  }> {
    const results: Array<{
      hash: string;
      contractName?: string;
      contractAddress?: string;
      type: string;
    }> = [];

    if (!fs.existsSync(logPath)) {
      return results;
    }

    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const data = JSON.parse(content);

      // Forge broadcast JSON has a "transactions" array
      const txs = data.transactions || [];
      for (const tx of txs) {
        results.push({
          hash: tx.hash || '',
          contractName: tx.contractName || tx.contract_name || undefined,
          contractAddress: tx.contractAddress || tx.contract_address || undefined,
          type: tx.transactionType || tx.transaction_type || 'unknown',
        });
      }
    } catch {
      // Malformed JSON or missing fields
    }

    return results;
  }

  /** Generate report */
  generateReport(result: ScriptResult, config: ScriptConfig): string {
    const lines: string[] = [
      '## Forge Script Report',
      '',
      `- **Script:** \`${path.basename(config.scriptPath)}\``,
      `- **Status:** ${result.success ? 'Success' : 'Failed'}`,
      `- **Mode:** ${config.broadcast ? 'Broadcast' : 'Simulation'}`,
    ];

    if (config.rpcUrl) {
      lines.push(`- **RPC:** ${config.rpcUrl}`);
    }

    if (result.gasUsed !== undefined) {
      lines.push(`- **Total Gas Used:** ${result.gasUsed.toLocaleString()}`);
    }

    if (result.transactions && result.transactions.length > 0) {
      lines.push('', '### Transactions', '');
      lines.push('| # | Type | Contract | Function | Gas |');
      lines.push('|---|------|----------|----------|-----|');

      result.transactions.forEach((tx, i) => {
        const name = tx.contractName || '-';
        const fn = tx.function || '-';
        const gas = tx.gas !== undefined ? tx.gas.toLocaleString() : '-';
        lines.push(`| ${i + 1} | ${tx.type} | ${name} | ${fn} | ${gas} |`);
      });
    }

    if (result.broadcastLog) {
      lines.push('', `**Broadcast log:** \`${result.broadcastLog}\``);
    }

    if (!result.success && result.stderr) {
      lines.push('', '### Errors', '', '```', result.stderr.substring(0, 2000), '```');
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Build CLI arguments from config.
   */
  private buildArgs(config: ScriptConfig): string[] {
    const args: string[] = [config.scriptPath];

    if (config.targetContract) {
      args.push('--target-contract', config.targetContract);
    }

    if (config.sig) {
      args.push('--sig', config.sig);
    }

    if (config.rpcUrl) {
      args.push('--rpc-url', config.rpcUrl);
    } else if (config.forkUrl) {
      args.push('--fork-url', config.forkUrl);
    }

    if (config.privateKey) {
      args.push('--private-key', config.privateKey);
    }

    if (config.broadcast) {
      args.push('--broadcast');
    }

    if (config.verify) {
      args.push('--verify');
    }

    if (config.etherscanApiKey) {
      args.push('--etherscan-api-key', config.etherscanApiKey);
    }

    if (config.slow) {
      args.push('--slow');
    }

    if (config.verbosity !== undefined && config.verbosity > 0) {
      args.push('-' + 'v'.repeat(Math.min(config.verbosity, 5)));
    }

    if (config.gasEstimate !== undefined) {
      args.push('--gas-estimate-multiplier', String(config.gasEstimate));
    }

    if (config.legacy) {
      args.push('--legacy');
    }

    if (config.additionalArgs) {
      args.push(...config.additionalArgs);
    }

    return args;
  }

  /**
   * Parse transactions from forge script output.
   *
   * Forge outputs lines like:
   *   == Logs ==
   *   ...
   *
   *   ## Setting up 1 EVM.
   *   ...
   *   [Success] Hash: 0x...
   *     Contract Address: 0x...
   *     Gas used: 12345
   *
   * Or in newer versions with table-style output for simulations.
   */
  private parseTransactions(output: string): ScriptTransaction[] {
    const transactions: ScriptTransaction[] = [];

    // Pattern 1: Success lines with hash
    SUCCESS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SUCCESS_PATTERN.exec(output)) !== null) {
      transactions.push({
        hash: match[1],
        contractAddress: match[2] || undefined,
        type: match[2] ? 'create' : 'call',
        gas: match[3] ? parseInt(match[3], 10) : undefined,
      });
    }

    // Pattern 2: CREATE or CALL entries from simulation table
    CREATE_PATTERN.lastIndex = 0;
    while ((match = CREATE_PATTERN.exec(output)) !== null) {
      const addr = match[2];
      const name = match[1];
      // Avoid duplicates
      if (!transactions.some((t) => t.contractAddress === addr)) {
        transactions.push({
          contractName: name,
          contractAddress: addr,
          type: 'create',
        });
      }
    }

    // Pattern 3: Contract creations from "new <Name>" lines
    NEW_CONTRACT_PATTERN.lastIndex = 0;
    while ((match = NEW_CONTRACT_PATTERN.exec(output)) !== null) {
      const addr = match[2];
      const name = match[1];
      const gas = parseInt(match[3], 10);
      if (!transactions.some((t) => t.contractAddress === addr)) {
        transactions.push({
          contractName: name,
          contractAddress: addr,
          type: 'create',
          gas,
        });
      }
    }

    return transactions;
  }

  /**
   * Parse total gas used from forge script output.
   */
  private parseGasUsed(output: string): number | undefined {
    // Look for "Total gas used" or similar aggregate line
    const totalGasMatch = TOTAL_GAS_PATTERN.exec(output);
    if (totalGasMatch) {
      return parseInt(totalGasMatch[1].replace(/,/g, ''), 10);
    }

    // Sum individual gas amounts if no total
    GAS_LINE_PATTERN.lastIndex = 0;
    let total = 0;
    let found = false;
    let match;
    while ((match = GAS_LINE_PATTERN.exec(output)) !== null) {
      total += parseInt(match[1].replace(/,/g, ''), 10);
      found = true;
    }

    return found ? total : undefined;
  }

  /**
   * Find broadcast log JSON file for a script.
   */
  private findBroadcastLog(config: ScriptConfig): string | undefined {
    if (!config.broadcast) {
      return undefined;
    }

    const projectRoot = this.findProjectRoot(config.scriptPath);
    if (!projectRoot) {
      return undefined;
    }

    const scriptName = path.basename(config.scriptPath, '.s.sol');
    const broadcastDir = path.join(projectRoot, 'broadcast', scriptName + '.s.sol');

    if (!fs.existsSync(broadcastDir)) {
      return undefined;
    }

    // Look for the most recent run-*.json file
    try {
      const entries = fs.readdirSync(broadcastDir, { withFileTypes: true });
      // Check chain-specific subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const chainDir = path.join(broadcastDir, entry.name);
          const files = fs.readdirSync(chainDir);
          const runFiles = files
            .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
            .sort()
            .reverse();
          if (runFiles.length > 0) {
            return path.join(chainDir, runFiles[0]);
          }
        }
      }
    } catch {
      // readdir errors
    }

    return undefined;
  }

  /**
   * Find the Foundry project root (contains foundry.toml).
   */
  private findProjectRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  /**
   * Recursively walk a directory and call callback for each file.
   */
  private walkDir(dir: string, callback: (filePath: string) => void): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.walkDir(fullPath, callback);
        } else if (entry.isFile()) {
          callback(fullPath);
        }
      }
    } catch {
      // Ignore permission errors etc.
    }
  }
}
