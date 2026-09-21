/**
 * Shared AI tool registry — the single source of truth for every capability
 * 0xTools exposes to AI agents. Pure Node (no `vscode` import) so the same
 * definitions serve both the MCP server (`0xtools mcp`, any MCP client) and
 * the VS Code Language Model tools adapter (Copilot agent mode).
 *
 * Results are returned as JSON strings: deterministic ground truth an agent
 * can quote instead of hallucinating gas numbers, selectors, or findings.
 */

import * as fs from 'fs';

import { glob } from 'glob';

import { analyzeSource, runAudit, AuditFinding } from '../../cli/audit-command';
import { SolidityParser } from '../../core/parser';
import { FourByteLookup } from '../four-byte-lookup';
import {
  keccakUtf8,
  keccakHex,
  selectorOfCanonicalSignature,
  topic0OfCanonicalSignature,
  toChecksumAddress,
  isValidAddress,
  buildConversions,
  encodeFunctionCallData,
  abiEncodeParams,
  decodeCalldata,
  decodeRawTransaction,
  computeCreateAddress,
  computeCreate2Address,
  mappingEntrySlot,
  erc7201Slot,
  wellKnownSlots,
  ethConstants,
  describeEpoch,
  parseEpochInput,
  MappingKeyType,
} from '../eth-tools';

export interface AiTool {
  /** snake_case, stable — used as the MCP tool name and (prefixed) LM tool name. */
  name: string;
  description: string;
  /** Plain JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
  /** Returns a JSON string (agents parse it); throws on invalid input. */
  run(args: Record<string, unknown>): Promise<string>;
}

const fourByte = new FourByteLookup();

function j(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === 'string' && v.length > 0) {
    return v;
  }
  if (!required) {
    return '';
  }
  throw new Error(`missing required string argument "${key}"`);
}

function summarizeFindings(findings: AuditFinding[]) {
  const bySeverity: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }
  return { total: findings.length, bySeverity, findings };
}

export function buildAiTools(): AiTool[] {
  return [
    {
      name: 'audit_solidity',
      description:
        'Run the 0xTools security analyzers (reentrancy, unchecked calls, access control, missing events, natspec, dangerous patterns, DeFi risks, MEV) over Solidity code. Pass either `source` (contract code) or `path` (file or project directory). Returns findings with file, line, severity, and message — deterministic static analysis, not model guesses.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Solidity source code to audit' },
          path: {
            type: 'string',
            description: 'Absolute path to a .sol file or project directory',
          },
        },
      },
      async run(args) {
        const source = str(args, 'source', false);
        const p = str(args, 'path', false);
        if (source) {
          return j(summarizeFindings(analyzeSource('input.sol', source)));
        }
        if (!p) {
          throw new Error('pass either "source" or "path"');
        }
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          return j(summarizeFindings(analyzeSource(p, fs.readFileSync(p, 'utf8'))));
        }
        const findings = await runAudit(p, { suppressions: true });
        return j(summarizeFindings(findings));
      },
    },
    {
      name: 'scan_signatures',
      description:
        'Scan a Solidity project (or single file) and return every contract with its function/event/error signatures and exact 4-byte selectors / 32-byte topics. Ground truth from the parser — use instead of computing selectors by hand.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to a .sol file or project directory',
          },
        },
        required: ['path'],
      },
      async run(args) {
        const p = str(args, 'path');
        const parser = new SolidityParser();
        const files = fs.statSync(p).isFile()
          ? [p]
          : await glob('**/*.sol', {
              cwd: p,
              absolute: true,
              ignore: ['**/node_modules/**', '**/lib/**', '**/out/**', '**/artifacts/**'],
            });
        const contracts = files.map((file) => parser.parseFile(file)).filter((c) => c !== null);
        return j(contracts);
      },
    },
    {
      name: 'lookup_selector',
      description:
        'Resolve a 4-byte function selector (e.g. 0xa9059cbb) to known text signatures via the 4byte.directory (cached locally). Returns candidate signatures; empty if unknown or offline.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '4-byte selector, e.g. 0xa9059cbb' },
        },
        required: ['selector'],
      },
      async run(args) {
        const selector = str(args, 'selector');
        const signatures = await fourByte.lookup(selector);
        return j({ selector, signatures });
      },
    },
    {
      name: 'compute_selector',
      description:
        'Compute the exact 4-byte selector and 32-byte event topic0 for a canonical Solidity signature like transfer(address,uint256). Deterministic keccak-256 — never guess a selector.',
      inputSchema: {
        type: 'object',
        properties: {
          signature: {
            type: 'string',
            description: 'Canonical signature, e.g. transfer(address,uint256)',
          },
        },
        required: ['signature'],
      },
      async run(args) {
        const signature = str(args, 'signature');
        return j({
          signature,
          selector: selectorOfCanonicalSignature(signature),
          topic0: topic0OfCanonicalSignature(signature),
        });
      },
    },
    {
      name: 'decode_calldata',
      description:
        'Decode raw EVM calldata into function name and typed arguments. Uses workspace signatures when available plus the 4byte directory. Returns candidate decodings with parameter values.',
      inputSchema: {
        type: 'object',
        properties: {
          calldata: { type: 'string', description: '0x-prefixed calldata blob' },
        },
        required: ['calldata'],
      },
      async run(args) {
        const calldata = str(args, 'calldata');
        const decoded = await decodeCalldata(calldata, {
          online: (sel) => fourByte.lookup(sel),
        });
        return j(decoded);
      },
    },
    {
      name: 'encode_calldata',
      description:
        'ABI-encode a function call from a human signature and argument list, e.g. signature "transfer(address,uint256)" args "0xabc…, 1000000". Returns selector + full calldata hex.',
      inputSchema: {
        type: 'object',
        properties: {
          signature: {
            type: 'string',
            description: 'Function signature, e.g. transfer(address,uint256)',
          },
          args: {
            type: 'string',
            description: 'Comma-separated argument values (empty string for none)',
          },
        },
        required: ['signature'],
      },
      async run(args) {
        return j(encodeFunctionCallData(str(args, 'signature'), str(args, 'args', false)));
      },
    },
    {
      name: 'abi_encode_params',
      description:
        'ABI-encode standalone parameters (no selector): pass a type list like "address,uint256" and comma-separated values. Returns the encoded hex.',
      inputSchema: {
        type: 'object',
        properties: {
          types: { type: 'string', description: 'Comma-separated Solidity types' },
          values: { type: 'string', description: 'Comma-separated values' },
        },
        required: ['types', 'values'],
      },
      async run(args) {
        return j({ encoded: abiEncodeParams(str(args, 'types'), str(args, 'values')) });
      },
    },
    {
      name: 'decode_raw_transaction',
      description: 'Decode a raw signed Ethereum transaction (RLP hex) into its fields.',
      inputSchema: {
        type: 'object',
        properties: {
          raw: { type: 'string', description: '0x-prefixed raw transaction hex' },
        },
        required: ['raw'],
      },
      async run(args) {
        return j(decodeRawTransaction(str(args, 'raw')));
      },
    },
    {
      name: 'keccak256',
      description:
        'Keccak-256 hash. mode "utf8" hashes the text bytes; mode "hex" hashes a 0x-prefixed byte string.',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          mode: { type: 'string', enum: ['utf8', 'hex'], description: 'default utf8' },
        },
        required: ['input'],
      },
      async run(args) {
        const input = str(args, 'input');
        const mode = str(args, 'mode', false) || 'utf8';
        return j({ input, mode, hash: mode === 'hex' ? keccakHex(input) : keccakUtf8(input) });
      },
    },
    {
      name: 'convert_eth_units',
      description:
        'Convert an amount between wei / gwei / ether (and every other named unit). Input like "1.5 ether", "21000 gwei", or a bare wei value. Returns the full conversion table.',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'string', description: 'e.g. "1.5 ether" or "1000000000"' },
        },
        required: ['amount'],
      },
      async run(args) {
        return j(buildConversions(str(args, 'amount')));
      },
    },
    {
      name: 'compute_contract_address',
      description:
        'Compute a deterministic contract address: CREATE (deployer + nonce) or CREATE2 (deployer + salt + init code hash).',
      inputSchema: {
        type: 'object',
        properties: {
          deployer: { type: 'string', description: 'Deployer address' },
          nonce: { type: 'string', description: 'CREATE: deployer account nonce' },
          salt: { type: 'string', description: 'CREATE2: 32-byte salt' },
          initCodeHash: { type: 'string', description: 'CREATE2: keccak256 of init code' },
        },
        required: ['deployer'],
      },
      async run(args) {
        const deployer = str(args, 'deployer');
        if (!isValidAddress(deployer)) {
          throw new Error('invalid deployer address');
        }
        const salt = str(args, 'salt', false);
        const initCodeHash = str(args, 'initCodeHash', false);
        if (salt && initCodeHash) {
          return j({
            kind: 'CREATE2',
            address: computeCreate2Address(deployer, salt, initCodeHash),
          });
        }
        const nonce = str(args, 'nonce', false) || '0';
        return j({ kind: 'CREATE', address: computeCreateAddress(deployer, BigInt(nonce)) });
      },
    },
    {
      name: 'storage_slot',
      description:
        'Compute EVM storage slots: mapping entry slot (baseSlot + key + keyType), ERC-7201 namespaced slot, or list well-known proxy slots (pass no args for the list).',
      inputSchema: {
        type: 'object',
        properties: {
          baseSlot: { type: 'string', description: 'Mapping: declared slot number' },
          key: { type: 'string', description: 'Mapping: key value' },
          keyType: { type: 'string', description: 'Mapping: address|uint256|bytes32|string' },
          erc7201Namespace: { type: 'string', description: 'ERC-7201 namespace id' },
        },
      },
      async run(args) {
        const ns = str(args, 'erc7201Namespace', false);
        if (ns) {
          return j({ namespace: ns, slot: erc7201Slot(ns) });
        }
        const baseSlot = str(args, 'baseSlot', false);
        const key = str(args, 'key', false);
        if (baseSlot && key) {
          const keyType = (str(args, 'keyType', false) || 'address') as MappingKeyType;
          return j({ slot: mappingEntrySlot(keyType, key, BigInt(baseSlot)) });
        }
        return j(wellKnownSlots());
      },
    },
    {
      name: 'checksum_address',
      description: 'Validate an Ethereum address and return its EIP-55 checksummed form.',
      inputSchema: {
        type: 'object',
        properties: { address: { type: 'string' } },
        required: ['address'],
      },
      async run(args) {
        const address = str(args, 'address');
        return j({ valid: isValidAddress(address), checksummed: toChecksumAddress(address) });
      },
    },
    {
      name: 'eth_reference',
      description:
        'Reference data: EVM/ETH constants (max uint256, zero address, gas costs…) and epoch/duration conversion. Pass `epoch` to describe a unix timestamp, omit for the constants table.',
      inputSchema: {
        type: 'object',
        properties: {
          epoch: { type: 'string', description: 'Unix timestamp (s or ms) or ISO date' },
        },
      },
      async run(args) {
        const epoch = str(args, 'epoch', false);
        if (epoch) {
          const info = parseEpochInput(epoch, Date.now());
          if (!info) {
            throw new Error('unrecognized epoch/date input');
          }
          return j(describeEpoch(info, Date.now()));
        }
        return j(ethConstants());
      },
    },
  ];
}
