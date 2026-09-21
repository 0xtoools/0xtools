// Runs a discovered deploy script and streams its output.
//
//   Foundry  → `forge script <relPath>:<Contract> --broadcast --rpc-url <url>
//                --unlocked --sender <address>` (signing happens on the node;
//                the extension never handles key material)
//   Hardhat  → `npx hardhat run <relPath> --network <name>` (or default network)
//
// We parse stdout for newly-deployed contract addresses so the panel can
// surface them in the tx log just like a manual deploy.

import { spawn, type ChildProcess } from 'child_process';
import type { ScriptEntry } from './script-discovery';

export interface RunScriptOptions {
  script: ScriptEntry;
  /** RPC URL of the network we're running against. */
  rpcUrl: string;
  /** Display name of the network for logging. */
  networkLabel: string;
  /** Hardhat-only — the --network flag value (e.g. "sepolia"). Optional. */
  hardhatNetwork?: string;
  /** Signer source — used to choose the right CLI flag. */
  signer:
    | { kind: 'unlocked'; sender: string } // node-side signing (anvil's unlocked accounts)
    | { kind: 'none' }; // hardhat scripts may use the hardhat config's own accounts
  /** Stream each output line back to the caller. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Wall-clock cap, defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface RunScriptResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  errorMessage?: string;
  /** Parsed `Contract Deployed` / `Deployed to` matches from output. */
  deployedContracts: Array<{ name?: string; address: string }>;
  /** Parsed transaction hashes from output. */
  txHashes: string[];
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const PER_RPC_TIMEOUT_MS = 60_000;
void PER_RPC_TIMEOUT_MS;

// Regexes for parsing forge/hardhat output.
//   forge script: "Contract Address: 0x..." and "Hash: 0x..."
//   forge create: "Deployed to: 0x..."
//   hardhat:      script-defined — most commonly "Name -> 0x..." / "Name => 0x..."
//                 (e.g. `console.log("PlayerNFT ->", addr)`) or a labelled
//                 "deployed to: 0x..." line. We accept all of these.
//
// Named arrow form captures the contract name from the start of the line so we
// can match it to a built ABI later. We deliberately only treat "->"/"=>" as a
// name separator (not a bare ":") so metadata lines like "Deployer: 0x..." or
// "Manager : 0x..." don't get mistaken for deployed contracts.
const NAMED_ADDR_RE = /^\s*([A-Za-z_$][\w$. ]*?)\s*(?:->|=>)\s*(0x[a-fA-F0-9]{40})\b/;
// Labelled form (no reliable name): "deployed to: 0x", "contract address: 0x",
// "address=0x" — also matches env dumps like "..._ADDRESS=0x...".
const LABELLED_ADDR_RE =
  /(?:deployed(?:\s+to)?|contract\s+address|address)\s*[:=]\s*(0x[a-fA-F0-9]{40})\b/gi;
const HASH_RE = /(?:hash|tx\s+hash|transaction\s+hash)\s*[:=]\s*(0x[a-fA-F0-9]{64})\b/gi;

function parseDeployedContracts(line: string): Array<{ name?: string; address: string }> {
  const out: Array<{ name?: string; address: string }> = [];
  const named = NAMED_ADDR_RE.exec(line);
  if (named) {
    const name = named[1].trim();
    out.push({ name: name || undefined, address: named[2] });
  }
  let m: RegExpExecArray | null;
  LABELLED_ADDR_RE.lastIndex = 0;
  while ((m = LABELLED_ADDR_RE.exec(line)) !== null) {
    out.push({ address: m[1] });
  }
  return out;
}

function parseTxHashes(line: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HASH_RE.lastIndex = 0;
  while ((m = HASH_RE.exec(line)) !== null) {
    out.push(m[1]);
  }
  return out;
}

interface CommandSpec {
  cmd: string;
  args: string[];
}

function buildCommand(opts: RunScriptOptions): CommandSpec {
  const { script, rpcUrl, signer } = opts;
  if (script.kind === 'foundry') {
    if (!script.foundryTarget) {
      throw new Error('foundry script is missing its target — re-discover scripts');
    }
    const args = ['script', script.foundryTarget, '--rpc-url', rpcUrl, '--broadcast'];
    if (signer.kind === 'unlocked') {
      args.push('--unlocked', '--sender', signer.sender);
      return { cmd: 'forge', args };
    }
    throw new Error(
      'foundry scripts sign on the local unlocked node: select an anvil account, ' +
        'or run `forge script --account <name>` in a terminal for keystore accounts'
    );
  }
  // Hardhat
  const args = ['hardhat', 'run', script.relPath];
  if (opts.hardhatNetwork) {
    args.push('--network', opts.hardhatNetwork);
  }
  return { cmd: 'npx', args };
}

export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const result: RunScriptResult = {
    ok: false,
    exitCode: null,
    durationMs: 0,
    deployedContracts: [],
    txHashes: [],
  };

  let spec: CommandSpec;
  try {
    spec = buildCommand(opts);
  } catch (err) {
    result.errorMessage = err instanceof Error ? err.message : String(err);
    return result;
  }

  const started = Date.now();

  return new Promise<RunScriptResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(spec.cmd, spec.args, {
        cwd: opts.script.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
    } catch (err) {
      result.errorMessage = `failed to spawn ${spec.cmd}: ${err instanceof Error ? err.message : err}`;
      result.durationMs = Date.now() - started;
      resolve(result);
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);

    function emitLines(buf: string, stream: 'stdout' | 'stderr'): string {
      const lines = buf.split('\n');
      const remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        opts.onLine?.(line, stream);
        for (const dc of parseDeployedContracts(line)) {
          const existing = result.deployedContracts.find(
            (c) => c.address.toLowerCase() === dc.address.toLowerCase()
          );
          if (!existing) {
            result.deployedContracts.push(dc);
          } else if (!existing.name && dc.name) {
            existing.name = dc.name; // upgrade a nameless entry once we learn its name
          }
        }
        for (const h of parseTxHashes(line)) {
          if (!result.txHashes.includes(h)) {
            result.txHashes.push(h);
          }
        }
      }
      return remainder;
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      stdoutBuf = emitLines(stdoutBuf, 'stdout');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderrBuf = emitLines(stderrBuf, 'stderr');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      result.errorMessage = `process error: ${err.message}`;
      result.durationMs = Date.now() - started;
      resolve(result);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (stdoutBuf.length > 0) {
        opts.onLine?.(stdoutBuf, 'stdout');
      }
      if (stderrBuf.length > 0) {
        opts.onLine?.(stderrBuf, 'stderr');
      }
      result.exitCode = code;
      result.durationMs = Date.now() - started;
      if (timedOut) {
        result.errorMessage = 'script timed out';
        resolve(result);
        return;
      }
      result.ok = code === 0;
      if (!result.ok) {
        result.errorMessage = `${spec.cmd} ${spec.args[0]} exited with code ${code}`;
      }
      void opts.networkLabel; // currently unused but kept in API for logging
      resolve(result);
    });
  });
}
