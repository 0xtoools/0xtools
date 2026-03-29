/**
 * Runner Backend - Uses `sigscan-runner` Rust binary for gas estimation
 *
 * Spawns the sigscan-runner binary which compiles the .sol file, deploys it
 * in an in-memory EVM (revm), executes every function, and returns real
 * gas numbers as JSON. The extension then merges this with regex-parsed
 * source locations to produce GasInfo[] for inline decorations.
 *
 * This is the primary backend — fastest and most accurate since it uses
 * actual EVM execution rather than compiler estimates.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { keccak256 } from 'js-sha3';
import { GasInfo, CompilationOutput } from './SolcManager';

// ---------------------------------------------------------------------------
// Runner JSON types (matches runner/src/types.rs)
// ---------------------------------------------------------------------------

interface RunnerFunctionReport {
  name: string;
  selector: string;
  signature: string;
  gas: number;
  status: 'success' | 'revert' | 'halt';
  strategy?: string;
}

interface RunnerContractReport {
  contract: string;
  functions: RunnerFunctionReport[];
}

// ---------------------------------------------------------------------------
// New subcommand types (matches runner/src/types.rs)
// ---------------------------------------------------------------------------

export interface StorageSlot {
  slot: number;
  offset: number;
  access: 'read' | 'write' | 'readwrite';
}

export interface StorageLayoutReport {
  contract: string;
  slots: StorageSlot[];
}

export interface BasicBlock {
  id: number;
  start: number;
  end: number;
  successors: number[];
  opcodes: string[];
}

export interface CfgReport {
  contract: string;
  blocks: BasicBlock[];
}

export interface CallEdge {
  from_function: string;
  to_address: string;
  call_type: 'call' | 'staticcall' | 'delegatecall' | 'callcode';
  offset: number;
}

export interface CallGraphReport {
  contract: string;
  edges: CallEdge[];
}

export interface DecodedValue {
  type_name: string;
  value: string;
}

export interface AbiDecodeResult {
  selector: string | null;
  function: string | null;
  values: DecodedValue[];
}

export interface SignatureMatch {
  selector: string;
  signatures: string[];
}

export interface FuzzResult {
  function: string;
  selector: string;
  rounds: number;
  successes: number;
  reverts: number;
  halts: number;
  min_gas: number;
  max_gas: number;
  avg_gas: number;
}

export interface FuzzReport {
  contract: string;
  results: FuzzResult[];
}

// ---------------------------------------------------------------------------
// Session-level cache for runner availability
// ---------------------------------------------------------------------------

let runnerAvailableCache: boolean | null = null;
let runnerPathCache: string | null = null;

/**
 * Check if `sigscan-runner` is available.
 * Result is cached for the lifetime of the process.
 */
export async function isRunnerAvailable(): Promise<boolean> {
  if (runnerAvailableCache !== null) {
    return runnerAvailableCache;
  }

  const runnerPath = discoverRunnerPath();
  if (!runnerPath) {
    runnerAvailableCache = false;
    return false;
  }

  return new Promise((resolve) => {
    execFile(runnerPath, ['--help'], { timeout: 5000 }, (err) => {
      if (err) {
        runnerAvailableCache = false;
        resolve(false);
        return;
      }
      runnerAvailableCache = true;
      runnerPathCache = runnerPath;
      resolve(true);
    });
  });
}

/**
 * Reset the runner availability cache (useful for testing).
 */
export function resetRunnerCache(): void {
  runnerAvailableCache = null;
  runnerPathCache = null;
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

/**
 * Discover the sigscan-runner binary path.
 *
 * Search order:
 * 1. VS Code setting sigscan.runnerBinaryPath (if set)
 * 2. Extension bundled binary (bin/sigscan-runner)
 * 3. System PATH (sigscan-runner)
 * 4. Development fallback (runner/target/release/sigscan-runner)
 */
function discoverRunnerPath(): string | null {
  const binName = process.platform === 'win32' ? 'sigscan-runner.exe' : 'sigscan-runner';

  // 1. User-configured path + 2. Extension bundled binary
  try {
    // Try to load vscode — may not be available in CLI/test context
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const configPath: string = vscode.workspace
      .getConfiguration('sigscan')
      .get('runnerBinaryPath', '');
    if (configPath && fs.existsSync(configPath)) {
      return configPath;
    }

    const ext = vscode.extensions.getExtension('0xshubhs.sigscan');
    if (ext) {
      const bundledPath = path.join(ext.extensionPath, 'bin', binName);
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }
  } catch {
    // vscode not available (CLI/test context) — skip
  }

  // 3. System PATH — check with `which` / `where`
  const pathBinary = findOnPath(binName);
  if (pathBinary) {
    return pathBinary;
  }

  // 4. Development fallback — look relative to this file's location
  // Walk up to project root, then check runner/target/release/ and runner/target/debug/
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    for (const profile of ['release', 'debug']) {
      const candidate = path.join(dir, 'runner', 'target', profile, binName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    // Also check bin/ directory (for development with copied binary)
    const binCandidate = path.join(dir, 'bin', binName);
    if (fs.existsSync(binCandidate)) {
      return binCandidate;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Look for a binary on the system PATH.
 */
function findOnPath(binName: string): string | null {
  const pathEnv = process.env.PATH || '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(separator);

  for (const dir of dirs) {
    const candidate = path.join(dir, binName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared line-offset utilities
// ---------------------------------------------------------------------------

function buildLineOffsets(source: string): number[] {
  const lines = source.split('\n');
  const offsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + lines[i].length + 1);
  }
  return offsets;
}

function offsetToLine(lineOffsets: number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineOffsets[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1; // 1-based
}

// ---------------------------------------------------------------------------
// Main compilation entry point
// ---------------------------------------------------------------------------

/**
 * Compile and execute a .sol file using sigscan-runner.
 *
 * Spawns the runner binary, parses its JSON output, merges with
 * regex-parsed source locations, and returns a CompilationOutput.
 */
export async function compileWithRunner(
  filePath: string,
  source: string
): Promise<CompilationOutput> {
  const runnerPath = runnerPathCache || discoverRunnerPath();
  if (!runnerPath) {
    throw new Error('sigscan-runner binary not found');
  }

  try {
    const { stdout, stderr } = await spawnRunner(runnerPath, filePath);

    // Parse runner JSON output
    const reports: RunnerContractReport[] = JSON.parse(stdout);

    // Regex-parse the source for line locations, visibility, state mutability
    const lineOffsets = buildLineOffsets(source);
    const sourceMeta = extractFunctionMetadata(source, lineOffsets);

    // Merge runner gas data with source metadata
    const gasInfo: GasInfo[] = [];

    for (const report of reports) {
      for (const func of report.functions) {
        // Try exact signature match first, then fall back to name-based lookup
        const meta =
          sourceMeta.get(func.signature) ||
          [...sourceMeta.values()].find((m) => m.selector === func.selector) ||
          [...sourceMeta.entries()].find(([sig]) => sig.startsWith(func.name + '('))?.[1];

        const warnings: string[] = [];
        let gas: number | 'infinite' = func.gas;

        if (func.status === 'revert') {
          warnings.push('Estimated gas (function requires specific arguments to execute fully)');
        } else if (func.status === 'halt') {
          gas = 'infinite';
          warnings.push('Execution halted - possible unbounded gas');
        }

        gasInfo.push({
          name: func.name,
          selector: func.selector,
          gas,
          loc: meta?.loc || { line: 0, endLine: 0 },
          visibility: meta?.visibility || 'external',
          stateMutability: meta?.stateMutability || 'nonpayable',
          warnings,
        });
      }
    }

    // Append event topic decorations
    gasInfo.push(...extractEventMetadata(source, lineOffsets));

    return {
      success: true,
      version: 'runner',
      gasInfo,
      errors: [],
      warnings: stderr.trim() ? [stderr.trim()] : [],
    };
  } catch (error) {
    // Runner failed — return fallback with regex-only extraction
    const errorMsg = error instanceof Error ? error.message : 'runner failed';
    return fallbackResult(filePath, source, errorMsg);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the sigscan-runner binary and capture its output.
 */
function spawnRunner(
  runnerPath: string,
  filePath: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      runnerPath,
      [filePath],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`sigscan-runner failed: ${stderr || err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/**
 * Extract function metadata from Solidity source using regex.
 *
 * Returns a map of functionName → { loc, visibility, stateMutability, selector }.
 */
function extractFunctionMetadata(
  source: string,
  lineOffsets: number[]
): Map<
  string,
  {
    loc: { line: number; endLine: number };
    visibility: string;
    stateMutability: string;
    selector: string;
  }
> {
  const result = new Map<
    string,
    {
      loc: { line: number; endLine: number };
      visibility: string;
      stateMutability: string;
      selector: string;
    }
  >();

  const fnRegex =
    /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?[^{;]*[{;]/gs;

  let match;
  while ((match = fnRegex.exec(source)) !== null) {
    const [, name, paramsStr, visibility = 'internal', stateMutability = 'nonpayable'] = match;
    const startOffset = match.index;
    let endOffset = startOffset + match[0].length;

    // Track brace-matched end for functions with bodies
    if (match[0].endsWith('{')) {
      let braceCount = 1;
      let i = endOffset;
      while (i < source.length && braceCount > 0) {
        if (source[i] === '{') {
          braceCount++;
        } else if (source[i] === '}') {
          braceCount--;
        }
        i++;
      }
      endOffset = i;
    }

    // Compute selector from signature
    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const parts = param.split(/\s+/).filter((p) => p.length > 0);
        return parts[0] || 'unknown';
      });

    const signature = `${name}(${params.join(',')})`;
    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    // Use signature as key to handle overloaded functions correctly
    if (!result.has(signature)) {
      result.set(signature, {
        loc: {
          line: offsetToLine(lineOffsets, startOffset),
          endLine: offsetToLine(lineOffsets, endOffset),
        },
        visibility: visibility || 'internal',
        stateMutability: stateMutability || 'nonpayable',
        selector,
      });
    }
  }

  return result;
}

/**
 * Extract event metadata from Solidity source.
 * Returns GasInfo[] entries with the event topic hash as selector, gas: 0.
 */
function extractEventMetadata(source: string, lineOffsets: number[]): GasInfo[] {
  const events: GasInfo[] = [];

  const eventRegex = /event\s+(\w+)\s*\(([^)]*)\)\s*;/gs;
  let match;
  while ((match = eventRegex.exec(source)) !== null) {
    const [, name, paramsStr] = match;
    const params = paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        // Strip "indexed" keyword and variable name, keep only the type
        const parts = param
          .replace(/\bindexed\b/, '')
          .trim()
          .split(/\s+/)
          .filter((p) => p.length > 0);
        return parts[0] || 'unknown';
      });

    const signature = `${name}(${params.join(',')})`;
    const topic = '0x' + keccak256(signature);

    events.push({
      name,
      selector: topic.substring(0, 10), // Show first 4 bytes like function selectors
      gas: 0,
      loc: {
        line: offsetToLine(lineOffsets, match.index),
        endLine: offsetToLine(lineOffsets, match.index + match[0].length),
      },
      visibility: 'event',
      stateMutability: 'n/a',
      warnings: [],
    });
  }
  return events;
}

/**
 * Build a fallback CompilationOutput using regex extraction (selectors only, gas: 0).
 */
function fallbackResult(filePath: string, source: string, errorMessage: string): CompilationOutput {
  const src = source || (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');
  const lineOffsets = buildLineOffsets(src);
  const meta = extractFunctionMetadata(src, lineOffsets);
  const gasInfo: GasInfo[] = [];

  for (const [sig, data] of meta) {
    const fnName = sig.substring(0, sig.indexOf('('));
    gasInfo.push({
      name: fnName || sig,
      selector: data.selector,
      gas: 0,
      loc: data.loc,
      visibility: data.visibility,
      stateMutability: data.stateMutability,
      warnings: [`Gas unavailable - runner failed (${errorMessage})`],
    });
  }

  // Include events even in fallback
  gasInfo.push(...extractEventMetadata(src, lineOffsets));

  return {
    success: false,
    version: 'runner (fallback)',
    gasInfo,
    errors: [errorMessage],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// New subcommand wrappers
// ---------------------------------------------------------------------------

/**
 * Spawn the runner with a subcommand and arguments, returning parsed JSON.
 */
function spawnRunnerSubcommand<T>(args: string[]): Promise<T> {
  const runnerPath = runnerPathCache || discoverRunnerPath();
  if (!runnerPath) {
    throw new Error('sigscan-runner binary not found');
  }

  return new Promise((resolve, reject) => {
    execFile(
      runnerPath,
      args,
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`sigscan-runner ${args[0]} failed: ${stderr || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(
            new Error(
              `Failed to parse runner output: ${parseErr instanceof Error ? parseErr.message : 'unknown error'}`
            )
          );
        }
      }
    );
  });
}

/**
 * Analyze storage layout of a Solidity file.
 * Returns storage slot information for each contract.
 */
export async function analyzeStorageWithRunner(filePath: string): Promise<StorageLayoutReport[]> {
  return spawnRunnerSubcommand<StorageLayoutReport[]>(['storage-layout', filePath]);
}

/**
 * Generate a control flow graph for contracts in a Solidity file.
 * Returns basic blocks with edges for each contract.
 */
export async function buildCfgWithRunner(filePath: string): Promise<CfgReport[]> {
  return spawnRunnerSubcommand<CfgReport[]>(['cfg', filePath]);
}

/**
 * Build a call graph showing inter-contract calls.
 * Returns call edges for each contract.
 */
export async function buildCallGraphWithRunner(filePath: string): Promise<CallGraphReport[]> {
  return spawnRunnerSubcommand<CallGraphReport[]>(['call-graph', filePath]);
}

/**
 * Decode ABI-encoded data.
 * If types is provided, decodes using those types.
 * Otherwise, attempts auto-detection via selector lookup.
 */
export async function decodeAbiWithRunner(data: string, types?: string): Promise<AbiDecodeResult> {
  const args = ['abi-decode', data];
  if (types) {
    args.push('--types', types);
  }
  return spawnRunnerSubcommand<AbiDecodeResult>(args);
}

/**
 * Look up a function signature by 4-byte selector or name.
 * For selectors (e.g. "0xa9059cbb"), returns matching signatures.
 * For names (e.g. "transfer"), returns matching selectors.
 */
export async function lookupSignatureWithRunner(
  selector: string
): Promise<SignatureMatch | SignatureMatch[]> {
  return spawnRunnerSubcommand<SignatureMatch | SignatureMatch[]>(['sig-db', selector]);
}

/**
 * Fuzz test contract functions with random inputs.
 * Returns min/max/avg gas and success/revert/halt counts per function.
 */
export async function fuzzWithRunner(filePath: string, rounds?: number): Promise<FuzzReport[]> {
  const args = ['fuzz', filePath];
  if (rounds !== undefined) {
    args.push('--rounds', rounds.toString());
  }
  return spawnRunnerSubcommand<FuzzReport[]>(args);
}
