/**
 * Hardhat Integration — Project detection, compilation, testing, and deployment
 *
 * Integrates with Hardhat for projects that use it. Detects Hardhat projects,
 * parses configuration, runs tasks, compiles contracts, runs tests, and more.
 *
 * Uses `child_process.execFile` for short commands and `child_process.spawn`
 * for long-running processes (e.g., node). Config parsing is done via regex
 * on the config file content rather than executing it.
 *
 * Standalone — no VS Code dependency required.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn, ChildProcess } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HardhatConfig {
  networks: Record<
    string,
    {
      url?: string;
      chainId?: number;
      accounts?: string[];
    }
  >;
  solidity: {
    version: string;
    settings?: {
      optimizer?: { enabled: boolean; runs: number };
    };
  };
  paths?: {
    sources: string;
    tests: string;
    cache: string;
    artifacts: string;
  };
}

export interface HardhatTaskResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMAND_TIMEOUT_MS = 30_000;
const COMPILE_TIMEOUT_MS = 120_000;
const DEPLOY_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 300_000;

const CONFIG_FILES = ['hardhat.config.ts', 'hardhat.config.js'];

// ---------------------------------------------------------------------------
// HardhatIntegration
// ---------------------------------------------------------------------------

export class HardhatIntegration {
  private projectRoot: string | null;
  private _available: boolean | null;
  private _projectDetectionCache: Map<string, boolean>;
  private _configCache: Map<string, { config: HardhatConfig; timestamp: number }>;
  private _taskCache: Map<string, { tasks: string[]; timestamp: number }>;

  /** Config/task cache TTL: 30 seconds. */
  private static readonly CACHE_TTL = 30_000;

  constructor() {
    this.projectRoot = null;
    this._available = null;
    this._projectDetectionCache = new Map();
    this._configCache = new Map();
    this._taskCache = new Map();
  }

  /**
   * Check if the given directory is a Hardhat project.
   * Looks for hardhat.config.js/ts or hardhat in package.json dependencies.
   */
  async isHardhatProject(projectRoot: string): Promise<boolean> {
    // Check cache first
    const cached = this._projectDetectionCache.get(projectRoot);
    if (cached !== undefined) {
      return cached;
    }

    // Check for config files
    for (const configFile of CONFIG_FILES) {
      if (fs.existsSync(path.join(projectRoot, configFile))) {
        this._projectDetectionCache.set(projectRoot, true);
        return true;
      }
    }

    // Check package.json for hardhat dependency
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };
        if (allDeps.hardhat) {
          this._projectDetectionCache.set(projectRoot, true);
          return true;
        }
      } catch {
        // ignore parse errors
      }
    }

    this._projectDetectionCache.set(projectRoot, false);
    return false;
  }

  /**
   * Check if npx or the local hardhat binary is available (cached after first check).
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) {
      return this._available;
    }
    return new Promise((resolve) => {
      execFile('npx', ['hardhat', '--version'], { timeout: COMMAND_TIMEOUT_MS }, (err) => {
        this._available = !err;
        resolve(this._available);
      });
    });
  }

  /**
   * Parse hardhat.config.js/ts to extract configuration via regex.
   * Does not execute the config file.
   */
  async getConfig(projectRoot: string): Promise<HardhatConfig | null> {
    // Check cache (30s TTL)
    const cached = this._configCache.get(projectRoot);
    if (cached && Date.now() - cached.timestamp < HardhatIntegration.CACHE_TTL) {
      return cached.config;
    }

    let configContent = '';
    let configPath = '';

    for (const configFile of CONFIG_FILES) {
      const candidate = path.join(projectRoot, configFile);
      if (fs.existsSync(candidate)) {
        configContent = fs.readFileSync(candidate, 'utf-8');
        configPath = candidate;
        break;
      }
    }

    if (!configContent) {
      return null;
    }

    const config: HardhatConfig = {
      networks: {},
      solidity: {
        version: '0.8.20',
      },
    };

    // Extract Solidity version
    // Matches: solidity: "0.8.20" or version: "0.8.20"
    const versionMatch =
      configContent.match(/solidity\s*:\s*["'](\d+\.\d+\.\d+)["']/) ||
      configContent.match(/version\s*:\s*["'](\d+\.\d+\.\d+)["']/);
    if (versionMatch) {
      config.solidity.version = versionMatch[1];
    }

    // Extract optimizer settings
    // Matches: optimizer: { enabled: true, runs: 200 }
    const optimizerMatch = configContent.match(
      /optimizer\s*:\s*\{\s*enabled\s*:\s*(true|false)\s*,\s*runs\s*:\s*(\d+)\s*\}/
    );
    if (optimizerMatch) {
      config.solidity.settings = {
        optimizer: {
          enabled: optimizerMatch[1] === 'true',
          runs: parseInt(optimizerMatch[2], 10),
        },
      };
    }

    // Extract networks
    // Look for network blocks like: networkName: { url: "...", chainId: N }
    const networkBlockRegex =
      /(\w+)\s*:\s*\{[^}]*url\s*:\s*(?:["'`]([^"'`]+)["'`]|process\.env\.\w+)[^}]*\}/g;
    let netMatch;
    while ((netMatch = networkBlockRegex.exec(configContent)) !== null) {
      const networkName = netMatch[0];
      const name = netMatch[1];
      const url = netMatch[2] || '';

      // Skip if it's not a network config (could be a nested object)
      if (['solidity', 'paths', 'module', 'require', 'import'].includes(name)) {
        continue;
      }

      // Try to extract chainId
      const chainIdMatch = networkName.match(/chainId\s*:\s*(\d+)/);
      const chainId = chainIdMatch ? parseInt(chainIdMatch[1], 10) : undefined;

      config.networks[name] = { url, chainId };
    }

    // Also look for simple network entries
    const simpleNetRegex = /(\w+)\s*:\s*\{\s*url\s*:\s*["'`]([^"'`]+)["'`]\s*\}/g;
    while ((netMatch = simpleNetRegex.exec(configContent)) !== null) {
      const name = netMatch[1];
      if (!config.networks[name] && !['solidity', 'paths', 'module'].includes(name)) {
        config.networks[name] = { url: netMatch[2] };
      }
    }

    // Always include hardhat (local) network
    if (!config.networks.hardhat) {
      config.networks.hardhat = { url: 'http://127.0.0.1:8545', chainId: 31337 };
    }
    if (!config.networks.localhost) {
      config.networks.localhost = { url: 'http://127.0.0.1:8545', chainId: 31337 };
    }

    // Extract paths
    const sourcesMatch = configContent.match(/sources\s*:\s*["'`]([^"'`]+)["'`]/);
    const testsMatch = configContent.match(/tests\s*:\s*["'`]([^"'`]+)["'`]/);
    const cacheMatch = configContent.match(/cache\s*:\s*["'`]([^"'`]+)["'`]/);
    const artifactsMatch = configContent.match(/artifacts\s*:\s*["'`]([^"'`]+)["'`]/);

    config.paths = {
      sources: sourcesMatch ? sourcesMatch[1] : 'contracts',
      tests: testsMatch ? testsMatch[1] : 'test',
      cache: cacheMatch ? cacheMatch[1] : 'cache',
      artifacts: artifactsMatch ? artifactsMatch[1] : 'artifacts',
    };

    this.projectRoot = projectRoot;
    this._configCache.set(projectRoot, { config, timestamp: Date.now() });
    return config;
  }

  /**
   * Get available network names from the Hardhat config.
   */
  async getNetworks(projectRoot: string): Promise<string[]> {
    const config = await this.getConfig(projectRoot);
    if (!config) {
      return [];
    }
    return Object.keys(config.networks);
  }

  /**
   * Run a Hardhat task.
   *
   * @param projectRoot - Project root directory
   * @param task - Task name (e.g., 'compile', 'test', 'clean')
   * @param args - Optional task arguments as key-value pairs
   * @returns Task result with output and exit code
   */
  async runTask(
    projectRoot: string,
    task: string,
    args?: Record<string, string>
  ): Promise<HardhatTaskResult> {
    const cmdArgs = [task];

    if (args) {
      for (const [key, value] of Object.entries(args)) {
        if (value === 'true') {
          cmdArgs.push(`--${key}`);
        } else if (value !== 'false' && value !== '') {
          cmdArgs.push(`--${key}`, value);
        }
      }
    }

    return this.execHardhat(projectRoot, cmdArgs, COMMAND_TIMEOUT_MS);
  }

  /**
   * Compile contracts using Hardhat.
   */
  async compile(projectRoot: string): Promise<HardhatTaskResult> {
    return this.execHardhat(projectRoot, ['compile', '--force'], COMPILE_TIMEOUT_MS);
  }

  /**
   * Run tests using Hardhat.
   *
   * @param projectRoot - Project root directory
   * @param testFile - Optional specific test file to run
   * @param grep - Optional grep pattern to filter tests
   */
  async test(projectRoot: string, testFile?: string, grep?: string): Promise<HardhatTaskResult> {
    const args = ['test'];
    if (testFile) {
      args.push(testFile);
    }
    if (grep) {
      args.push('--grep', grep);
    }
    return this.execHardhat(projectRoot, args, TEST_TIMEOUT_MS);
  }

  /**
   * Clean Hardhat artifacts and cache.
   */
  async clean(projectRoot: string): Promise<HardhatTaskResult> {
    return this.execHardhat(projectRoot, ['clean'], COMMAND_TIMEOUT_MS);
  }

  /**
   * Run Hardhat console on a network.
   */
  async console(projectRoot: string, network?: string): Promise<HardhatTaskResult> {
    const args = ['console'];
    if (network) {
      args.push('--network', network);
    }
    // Console is interactive, so we just run it briefly to check it works
    return this.execHardhat(projectRoot, args, COMMAND_TIMEOUT_MS);
  }

  /**
   * Deploy contracts using hardhat-deploy or ignition.
   */
  async deploy(
    projectRoot: string,
    options?: {
      network?: string;
      tags?: string[];
      script?: string;
    }
  ): Promise<HardhatTaskResult> {
    // Determine if using hardhat-deploy or ignition
    const hasIgnition = fs.existsSync(path.join(projectRoot, 'ignition'));
    const hasDeploy = fs.existsSync(path.join(projectRoot, 'deploy'));

    let args: string[];

    if (options?.script) {
      args = ['run', options.script];
    } else if (hasIgnition) {
      args = ['ignition', 'deploy'];
    } else if (hasDeploy) {
      args = ['deploy'];
    } else {
      return {
        success: false,
        output: '',
        error: 'No deploy scripts found. Create a deploy/ directory or ignition/ module.',
        exitCode: 1,
      };
    }

    if (options?.network) {
      args.push('--network', options.network);
    }
    if (options?.tags && options.tags.length > 0) {
      args.push('--tags', options.tags.join(','));
    }

    return this.execHardhat(projectRoot, args, DEPLOY_TIMEOUT_MS);
  }

  /**
   * Verify a contract on a block explorer.
   */
  async verify(
    projectRoot: string,
    address: string,
    constructorArgs?: string[],
    network?: string
  ): Promise<HardhatTaskResult> {
    const args = ['verify', '--address', address];
    if (network) {
      args.push('--network', network);
    }
    if (constructorArgs && constructorArgs.length > 0) {
      args.push('--constructor-args', ...constructorArgs);
    }
    return this.execHardhat(projectRoot, args, COMMAND_TIMEOUT_MS);
  }

  /**
   * List available Hardhat tasks.
   */
  async listTasks(projectRoot: string): Promise<string[]> {
    // Check cache (30s TTL)
    const cached = this._taskCache.get(projectRoot);
    if (cached && Date.now() - cached.timestamp < HardhatIntegration.CACHE_TTL) {
      return cached.tasks;
    }

    const result = await this.execHardhat(projectRoot, ['--help'], COMMAND_TIMEOUT_MS);
    if (!result.success) {
      return [];
    }

    const tasks: string[] = [];
    const lines = result.output.split('\n');
    let inTaskSection = false;

    for (const line of lines) {
      if (line.includes('AVAILABLE TASKS') || line.includes('available tasks')) {
        inTaskSection = true;
        continue;
      }
      if (inTaskSection) {
        // Tasks are typically listed as "  taskName    description"
        const taskMatch = line.match(/^\s{2,}(\S+)\s/);
        if (taskMatch) {
          tasks.push(taskMatch[1]);
        } else if (line.trim() === '' && tasks.length > 0) {
          // End of task section
          break;
        }
      }
    }

    this._taskCache.set(projectRoot, { tasks, timestamp: Date.now() });
    return tasks;
  }

  /**
   * Flatten a contract (combine all imports into a single file).
   */
  async flatten(projectRoot: string, filePath?: string): Promise<HardhatTaskResult> {
    const args = ['flatten'];
    if (filePath) {
      args.push(filePath);
    }
    return this.execHardhat(projectRoot, args, COMMAND_TIMEOUT_MS);
  }

  /**
   * Start a local Hardhat node.
   * Returns the spawned process and RPC URL. Caller must manage the process lifetime.
   */
  async node(
    projectRoot: string,
    fork?: string
  ): Promise<{ process: ChildProcess; rpcUrl: string }> {
    const args = ['node'];
    if (fork) {
      args.push('--fork', fork);
    }

    const hardhatBin = this.findHardhatBin(projectRoot);

    const proc = spawn(hardhatBin.command, [...hardhatBin.prefixArgs, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Wait for the node to be ready
    const rpcUrl = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Default URL even if we didn't see the output
          resolve('http://127.0.0.1:8545');
        }
      }, 30_000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        // Hardhat node prints something like "Started HTTP and WebSocket JSON-RPC server at http://127.0.0.1:8545/"
        const urlMatch = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (!resolved && urlMatch) {
          resolved = true;
          clearTimeout(timeout);
          resolve(urlMatch[0]);
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Failed to start hardhat node: ${err.message}`));
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Hardhat node exited with code ${code}: ${stderr}`));
        }
      });
    });

    return { process: proc, rpcUrl };
  }

  /**
   * Generate a markdown report from a task result.
   */
  generateReport(result: HardhatTaskResult, task: string): string {
    const lines: string[] = [
      '# Hardhat Task Report',
      '',
      '## Task Details',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Task | \`${task}\` |`,
      `| Status | ${result.success ? 'Success' : 'Failed'} |`,
      `| Exit Code | ${result.exitCode} |`,
      '',
    ];

    if (result.output) {
      lines.push('## Output');
      lines.push('');
      lines.push('```');
      // Limit output to prevent overly large reports
      const maxLines = 200;
      const outputLines = result.output.split('\n');
      if (outputLines.length > maxLines) {
        lines.push(outputLines.slice(0, maxLines).join('\n'));
        lines.push(`\n... (${outputLines.length - maxLines} more lines truncated)`);
      } else {
        lines.push(result.output);
      }
      lines.push('```');
      lines.push('');
    }

    if (result.error) {
      lines.push('## Errors');
      lines.push('');
      lines.push('```');
      lines.push(result.error);
      lines.push('```');
      lines.push('');
    }

    // Try to extract useful metrics from compile output
    if (task === 'compile' && result.success) {
      const compiledMatch = result.output.match(/Compiled (\d+) Solidity file/);
      if (compiledMatch) {
        lines.push('## Compilation Summary');
        lines.push('');
        lines.push(`- Compiled **${compiledMatch[1]}** contract(s) successfully`);
        lines.push('');
      }
    }

    // Try to extract test results from test output
    if (task === 'test') {
      const passingMatch = result.output.match(/(\d+) passing/);
      const failingMatch = result.output.match(/(\d+) failing/);
      if (passingMatch || failingMatch) {
        lines.push('## Test Summary');
        lines.push('');
        if (passingMatch) {
          lines.push(`- **${passingMatch[1]}** test(s) passing`);
        }
        if (failingMatch) {
          lines.push(`- **${failingMatch[1]}** test(s) failing`);
        }
        lines.push('');
      }
    }

    lines.push('*Report generated by 0xTools Hardhat integration*');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Find the hardhat binary — prefer local node_modules, fall back to npx.
   */
  private findHardhatBin(projectRoot: string): {
    command: string;
    prefixArgs: string[];
  } {
    // Check for local hardhat binary
    const localBin = path.join(projectRoot, 'node_modules', '.bin', 'hardhat');
    if (fs.existsSync(localBin)) {
      return { command: localBin, prefixArgs: [] };
    }

    // Fall back to npx
    return { command: 'npx', prefixArgs: ['hardhat'] };
  }

  /**
   * Execute a hardhat command and return structured output.
   */
  private execHardhat(
    projectRoot: string,
    args: string[],
    timeoutMs: number
  ): Promise<HardhatTaskResult> {
    return new Promise((resolve) => {
      const bin = this.findHardhatBin(projectRoot);
      const fullArgs = [...bin.prefixArgs, ...args];

      execFile(
        bin.command,
        fullArgs,
        {
          cwd: projectRoot,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: {
            ...process.env,
            // Force color off for parseable output
            FORCE_COLOR: '0',
            NO_COLOR: '1',
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            // Hardhat often exits non-zero for compilation errors, test failures, etc.
            // That's normal — include stdout as the output.
            const exitCode = (err as any).code === 'ETIMEDOUT' ? -1 : (err as any).status || 1;
            resolve({
              success: false,
              output: stdout || '',
              error: stderr || err.message,
              exitCode,
            });
            return;
          }

          resolve({
            success: true,
            output: stdout || '',
            error: stderr || undefined,
            exitCode: 0,
          });
        }
      );
    });
  }
}
