/**
 * Forge Backend - Uses `forge build` for Foundry projects
 *
 * Instead of compiling with WASM solc-js, this backend shells out to
 * the locally-installed `forge` binary and reads gas estimates from
 * the resulting artifacts. This gives exact parity with `forge test --gas-report`.
 *
 * Forge artifact keys are canonical ABI signatures, so no normalisation headaches.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { keccak256 } from 'js-sha3';
import { GasInfo, CompilationOutput } from './SolcManager';

// ---------------------------------------------------------------------------
// Session-level cache for forge availability
// ---------------------------------------------------------------------------

let forgeAvailableCache: boolean | null = null;
let forgeVersionCache: string | null = null;

/**
 * Check if `forge` is on PATH and usable.
 * Result is cached for the lifetime of the process.
 */
export async function isForgeAvailable(): Promise<boolean> {
  if (forgeAvailableCache !== null) {
    return forgeAvailableCache;
  }

  return new Promise((resolve) => {
    execFile('forge', ['--version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        forgeAvailableCache = false;
        resolve(false);
        return;
      }
      forgeAvailableCache = true;
      // Extract version string from e.g. "forge Version: 1.4.1-stable" or "forge 0.2.0 (...)"
      const match = stdout.match(/forge\s+(?:Version:\s*)?([\d.]+)/);
      forgeVersionCache = match ? match[1] : 'unknown';
      resolve(true);
    });
  });
}

/**
 * Get the cached forge version string (call isForgeAvailable first).
 */
export function getForgeVersion(): string {
  return forgeVersionCache || 'unknown';
}

/**
 * Reset the forge availability cache (useful for testing).
 */
export function resetForgeCache(): void {
  forgeAvailableCache = null;
  forgeVersionCache = null;
}

// ---------------------------------------------------------------------------
// Foundry project detection
// ---------------------------------------------------------------------------

/**
 * Walk up from `filePath` looking for `foundry.toml`.
 * Returns the directory containing it, or null.
 */
export function findFoundryRoot(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Forge compilation
// ---------------------------------------------------------------------------

/** Shape of a single Forge artifact JSON. */
interface ForgeArtifact {
  abi?: Array<{
    type: string;
    name?: string;
    inputs?: Array<{ type: string; name: string }>;
    stateMutability?: string;
  }>;
  methodIdentifiers?: Record<string, string>; // "transfer(address,uint256)": "a9059cbb"
  evm?: {
    gasEstimates?: {
      external?: Record<string, string>;
      internal?: Record<string, string>;
      creation?: {
        codeDepositCost?: string;
        executionCost?: string;
        totalCost?: string;
      };
    };
  };
}

/**
 * Run `forge build` and read the resulting artifacts for a given source file.
 *
 * Returns a `CompilationOutput` compatible with the rest of SigScan.
 * On failure falls back to regex-based extraction (selectors only, gas: 0).
 */
export async function compileWithForge(
  filePath: string,
  projectRoot: string
): Promise<CompilationOutput> {
  try {
    // Run forge build with gas estimates output
    await runForgeBuild(projectRoot);

    // Determine which artifacts belong to this source file
    const fileName = path.basename(filePath, '.sol');
    const outDir = await getForgeOutDir(projectRoot);
    const artifactDir = path.join(outDir, `${fileName}.sol`);

    if (!fs.existsSync(artifactDir)) {
      // No artifacts for this file — maybe forge output is in a different structure
      return fallbackResult(filePath, `No forge artifacts found at ${artifactDir}`);
    }

    // Read all contract artifacts under <fileName>.sol/
    const gasInfo: GasInfo[] = [];
    const source = fs.readFileSync(filePath, 'utf-8');
    const artifactFiles = fs.readdirSync(artifactDir).filter((f) => f.endsWith('.json'));

    for (const artFile of artifactFiles) {
      const contractName = artFile.replace('.json', '');
      const artPath = path.join(artifactDir, artFile);
      const artifact: ForgeArtifact = JSON.parse(fs.readFileSync(artPath, 'utf-8'));

      const items = parseForgeArtifact(artifact, contractName, source);
      gasInfo.push(...items);
    }

    return {
      success: true,
      version: `forge ${getForgeVersion()}`,
      gasInfo,
      errors: [],
      warnings: [],
    };
  } catch (error) {
    return fallbackResult(filePath, error instanceof Error ? error.message : 'forge build failed');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Invoke `forge build --force --extra-output evm.gasEstimates` in projectRoot.
 */
function runForgeBuild(projectRoot: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'forge',
      ['build', '--extra-output', 'evm.gasEstimates'],
      { cwd: projectRoot, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`forge build failed: ${stderr || err.message}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Read the `out` directory from foundry.toml, defaulting to `<projectRoot>/out`.
 */
async function getForgeOutDir(projectRoot: string): Promise<string> {
  const tomlPath = path.join(projectRoot, 'foundry.toml');
  try {
    const toml = fs.readFileSync(tomlPath, 'utf-8');
    // Simple regex to find `out = "..."` in foundry.toml
    const match = toml.match(/^\s*out\s*=\s*["']([^"']+)["']/m);
    if (match) {
      return path.resolve(projectRoot, match[1]);
    }
  } catch {
    // Ignore, use default
  }
  return path.join(projectRoot, 'out');
}

/**
 * Parse a single Forge artifact into GasInfo entries.
 *
 * Uses `methodIdentifiers` for selectors and `evm.gasEstimates.external`
 * for gas values. Source line numbers are found by regex scan of the source.
 */
function parseForgeArtifact(
  artifact: ForgeArtifact,
  contractName: string,
  source: string
): GasInfo[] {
  const results: GasInfo[] = [];
  const methodIds = artifact.methodIdentifiers || {};
  const gasExt = artifact.evm?.gasEstimates?.external || {};
  const gasInt = artifact.evm?.gasEstimates?.internal || {};

  // Build a map of function line locations from source
  const fnLines = findFunctionLines(source);

  // Process ABI entries to get visibility and mutability
  const abiFunctions = new Map<string, { visibility: string; stateMutability: string }>();

  for (const entry of artifact.abi || []) {
    if (entry.type === 'function' && entry.name) {
      const params = (entry.inputs || []).map((i) => i.type).join(',');
      const sig = `${entry.name}(${params})`;
      abiFunctions.set(sig, {
        visibility: 'external', // ABI only contains external/public
        stateMutability: entry.stateMutability || 'nonpayable',
      });
    }
  }

  // Merge external gas estimates with methodIdentifiers
  for (const [sig, selectorHex] of Object.entries(methodIds)) {
    const selector = '0x' + selectorHex;
    const gasValue = parseForgeGas(gasExt[sig]);
    const abiInfo = abiFunctions.get(sig);
    const fnName = sig.substring(0, sig.indexOf('('));
    const loc = fnLines.get(fnName) || { line: 0, endLine: 0 };

    results.push({
      name: fnName,
      selector,
      gas: gasValue,
      loc,
      visibility: abiInfo?.visibility || 'external',
      stateMutability: abiInfo?.stateMutability || 'nonpayable',
      warnings: gasValue === 0 ? ['Gas estimate not available from forge'] : [],
    });
  }

  // Also include internal functions if we have estimates for them
  for (const [sig, gasStr] of Object.entries(gasInt)) {
    const fnName = sig.substring(0, sig.indexOf('('));
    // Skip if we already have this function from external
    if (results.some((r) => r.name === fnName)) {
      continue;
    }

    const hash = keccak256(sig);
    const selector = '0x' + hash.substring(0, 8);
    const gasValue = parseForgeGas(gasStr);
    const loc = fnLines.get(fnName) || { line: 0, endLine: 0 };

    results.push({
      name: fnName,
      selector,
      gas: gasValue,
      loc,
      visibility: 'internal',
      stateMutability: 'nonpayable',
      warnings: [],
    });
  }

  return results;
}

/**
 * Parse a forge gas string into a number or 'infinite'.
 */
function parseForgeGas(value: string | undefined): number | 'infinite' {
  if (!value) {
    return 0;
  }
  if (value === 'infinite') {
    return 'infinite';
  }
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Quick regex scan of Solidity source to find function start/end lines.
 * Returns a map of functionName → { line, endLine }.
 */
function findFunctionLines(source: string): Map<string, { line: number; endLine: number }> {
  const result = new Map<string, { line: number; endLine: number }>();
  const lines = source.split('\n');

  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  function offsetToLine(offset: number): number {
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

  const fnRegex =
    /function\s+(\w+)\s*\([^)]*\)\s*(?:public|external|internal|private)?\s*(?:pure|view|payable|nonpayable)?[^{;]*[{;]/gs;

  let match;
  while ((match = fnRegex.exec(source)) !== null) {
    const name = match[1];
    const startOffset = match.index;
    let endOffset = startOffset + match[0].length;

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

    // Only store the first occurrence (don't overwrite overloads — use first match)
    if (!result.has(name)) {
      result.set(name, {
        line: offsetToLine(startOffset),
        endLine: offsetToLine(endOffset),
      });
    }
  }

  return result;
}

/**
 * Build a fallback CompilationOutput using regex extraction.
 */
function fallbackResult(filePath: string, errorMessage: string): CompilationOutput {
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const gasInfo = extractFunctionsForFallback(source);

  return {
    success: false,
    version: 'forge (fallback)',
    gasInfo,
    errors: [errorMessage],
    warnings: [],
  };
}

/**
 * Minimal regex-based function extraction (same approach as SolcManager's extractFunctionsWithRegex).
 * Provides selectors but no gas estimates.
 */
function extractFunctionsForFallback(source: string): GasInfo[] {
  const results: GasInfo[] = [];
  const lines = source.split('\n');
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  function offsetToLine(offset: number): number {
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

  const fnRegex =
    /function\s+(\w+)\s*\(([^)]*?)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?[^{;]*[{;]/gs;

  let match;
  while ((match = fnRegex.exec(source)) !== null) {
    const [, name, paramsStr, visibility = 'internal', stateMutability = 'nonpayable'] = match;
    const startOffset = match.index;

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

    results.push({
      name,
      selector,
      gas: 0,
      loc: {
        line: offsetToLine(startOffset),
        endLine: offsetToLine(startOffset + match[0].length),
      },
      visibility: visibility || 'internal',
      stateMutability: stateMutability || 'nonpayable',
      warnings: ['Gas unavailable - forge build failed (check imports)'],
    });
  }

  return results;
}
