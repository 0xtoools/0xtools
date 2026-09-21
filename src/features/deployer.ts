// Deploy & interact wrapper. Uses ethers v6 for ABI handling and JSON-RPC.
// Transactions sign on the node itself (eth_sendTransaction against unlocked
// accounts, i.e. a local anvil): the extension never holds private keys,
// keystore passwords, or any other key material. Read-only calls go through
// the JsonRpcProvider directly (no signer required).

import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  isAddress,
  type ContractRunner,
  type InterfaceAbi,
  type JsonRpcSigner,
  type LogDescription,
  type TransactionReceipt,
} from 'ethers';
import type { AbiEntry } from './remix-port/tx-helper';

export type SignerSource = { kind: 'node'; address: string };

export interface DeployRequest {
  rpcUrl: string;
  signer: SignerSource;
  abi: AbiEntry[];
  bytecode: string;
  ctorArgs: unknown[];
  value?: bigint;
  gasLimit?: bigint;
}

export interface DeployResult {
  address: string;
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  effectiveGasPrice?: string;
}

export interface SendRequest {
  rpcUrl: string;
  signer: SignerSource;
  to: string;
  abi: AbiEntry[];
  funcName: string;
  args: unknown[];
  value?: bigint;
  gasLimit?: bigint;
}

export interface SendResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
  status: 'success' | 'reverted';
  decodedLogs: Array<{ name: string; args: Record<string, unknown> }>;
  rawLogs: Array<{ address: string; topics: string[]; data: string }>;
}

export interface CallRequest {
  rpcUrl: string;
  to: string;
  abi: AbiEntry[];
  funcName: string;
  args: unknown[];
  value?: bigint;
}

export interface CallResult {
  decoded: unknown;
  raw: string;
}

async function resolveSigner(
  source: SignerSource,
  provider: JsonRpcProvider
): Promise<JsonRpcSigner> {
  // Node-side signing only: the account must be unlocked on the RPC node
  // (anvil's dev accounts are). The extension never touches key material.
  return provider.getSigner(source.address);
}

function serializeForJson(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForJson);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as object)) {
      // skip numeric keys that mirror named keys in ethers Result objects
      if (/^\d+$/.test(k)) {
        continue;
      }
      out[k] = serializeForJson(v);
    }
    return out;
  }
  return value;
}

function decodeReceiptLogs(
  receipt: TransactionReceipt,
  abi: AbiEntry[]
): SendResult['decodedLogs'] {
  if (!receipt.logs || receipt.logs.length === 0) {
    return [];
  }
  const iface = new Interface(abi as InterfaceAbi);
  const out: SendResult['decodedLogs'] = [];
  for (const log of receipt.logs) {
    let parsed: LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) {
      continue;
    }
    const args: Record<string, unknown> = {};
    for (let i = 0; i < parsed.fragment.inputs.length; i++) {
      const name = parsed.fragment.inputs[i].name || i.toString();
      args[name] = serializeForJson(parsed.args[i]);
    }
    out.push({ name: parsed.name, args });
  }
  return out;
}

// ─── Revert decoding ─────────────────────────────────────────────────────

const SELECTOR_ERROR = '0x08c379a0'; // Error(string)
const SELECTOR_PANIC = '0x4e487b71'; // Panic(uint256)

function extractRevertData(err: unknown): string | null {
  if (!err || typeof err !== 'object') {
    return null;
  }
  const e = err as Record<string, unknown>;
  if (typeof e.data === 'string') {
    return e.data as string;
  }
  const info = e.info as Record<string, unknown> | undefined;
  const innerErr = info?.error as Record<string, unknown> | undefined;
  if (typeof innerErr?.data === 'string') {
    return innerErr.data as string;
  }
  // Some providers nest one level deeper:
  const tx = e.transaction as Record<string, unknown> | undefined;
  if (typeof tx?.data === 'string' && (tx.data as string).length > 10) {
    // not revert data — that's the original calldata; skip.
  }
  return null;
}

function tryDecodeError(abi: AbiEntry[], data: string): string | null {
  if (!data || !data.startsWith('0x') || data.length < 10) {
    return null;
  }
  try {
    const iface = new Interface(abi as never);
    const parsed = iface.parseError(data);
    if (parsed) {
      const args = parsed.args.map((v) => serializeForJson(v));
      return `${parsed.name}(${args.map((a) => formatScalar(a)).join(', ')})`;
    }
  } catch {
    /* fall through */
  }
  return null;
}

function formatScalar(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Best-effort decode of a contract-call revert. Tries, in order:
 *   1. Custom errors defined in the provided ABI (ethers Interface.parseError)
 *   2. The standard `Error(string)` selector — decoded to a quoted string
 *   3. The standard `Panic(uint256)` selector — mapped to a human name
 *   4. Empty revert data → "no revert reason; common cause: ETH sent to a non-payable function"
 *   5. ethers' own `reason` field as a last resort
 */
export function decodeRevert(abi: AbiEntry[], err: unknown): string {
  const data = extractRevertData(err);
  if (data && data !== '0x') {
    const custom = tryDecodeError(abi, data);
    if (custom) {
      return custom;
    }
    if (data.toLowerCase().startsWith(SELECTOR_ERROR)) {
      try {
        const decoded = AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10));
        return `Error("${decoded[0]}")`;
      } catch {
        /* fall through */
      }
    }
    if (data.toLowerCase().startsWith(SELECTOR_PANIC)) {
      try {
        const decoded = AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10));
        const code = Number(decoded[0]);
        return `Panic(0x${code.toString(16)}) — ${panicMessage(code)}`;
      } catch {
        /* fall through */
      }
    }
    return `revert (${data.slice(0, 10)}…) — selector not in ABI`;
  }
  // No revert data at all — most common cause is ETH sent to a non-payable function/constructor.
  if (data === '0x') {
    return 'reverted with no data — common cause: sending ETH to a non-payable function or constructor';
  }
  const e = err as { reason?: string; shortMessage?: string; message?: string } | null;
  return e?.shortMessage ?? e?.reason ?? e?.message ?? 'unknown error';
}

function panicMessage(code: number): string {
  switch (code) {
    case 0x01:
      return 'assert(false)';
    case 0x11:
      return 'arithmetic overflow/underflow';
    case 0x12:
      return 'division or modulo by zero';
    case 0x21:
      return 'invalid enum value';
    case 0x22:
      return 'malformed storage byte array';
    case 0x31:
      return 'pop on empty array';
    case 0x32:
      return 'array index out of bounds';
    case 0x41:
      return 'out of memory (huge allocation)';
    case 0x51:
      return 'call to uninitialized internal function';
    default:
      return 'unknown panic';
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function deployContract(req: DeployRequest): Promise<DeployResult> {
  const provider = new JsonRpcProvider(req.rpcUrl);
  try {
    const wallet = await resolveSigner(req.signer, provider);
    const factory = new ContractFactory(req.abi as InterfaceAbi, req.bytecode, wallet);
    const overrides: Record<string, bigint> = {};
    if (req.value !== undefined) {
      overrides.value = req.value;
    }
    if (req.gasLimit !== undefined) {
      overrides.gasLimit = req.gasLimit;
    }
    const contract = await factory.deploy(...req.ctorArgs, overrides);
    const tx = contract.deploymentTransaction();
    if (!tx) {
      throw new Error('deployment transaction was not produced');
    }
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error('deployment receipt was not produced');
    }
    const address = await contract.getAddress();
    return {
      address,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.gasPrice?.toString(),
    };
  } finally {
    provider.destroy();
  }
}

export async function sendTransaction(req: SendRequest): Promise<SendResult> {
  if (!isAddress(req.to)) {
    throw new Error(`invalid address: ${req.to}`);
  }
  const provider = new JsonRpcProvider(req.rpcUrl);
  try {
    // Verify the address actually has bytecode on this RPC's chain. Without
    // this check ethers throws "could not decode result data" for empty
    // responses — opaque to anyone who didn't realize they switched networks.
    const code = await provider.getCode(req.to);
    if (!code || code === '0x') {
      throw new Error(
        `No contract found at ${req.to} on this network. ` +
          `Was this deployed to a different network?`
      );
    }
    const wallet = await resolveSigner(req.signer, provider);
    const contract = new Contract(req.to, req.abi as InterfaceAbi, wallet as ContractRunner);
    const overrides: Record<string, bigint> = {};
    if (req.value !== undefined) {
      overrides.value = req.value;
    }
    if (req.gasLimit !== undefined) {
      overrides.gasLimit = req.gasLimit;
    }
    const fn = contract.getFunction(req.funcName);
    const tx = await fn(...req.args, overrides);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error('transaction receipt was not produced');
    }
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status === 1 ? 'success' : 'reverted',
      decodedLogs: decodeReceiptLogs(receipt, req.abi),
      rawLogs: receipt.logs.map(
        (l: { address: string; topics: ReadonlyArray<string>; data: string }) => ({
          address: l.address,
          topics: [...l.topics],
          data: l.data,
        })
      ),
    };
  } finally {
    provider.destroy();
  }
}

export async function callFunction(req: CallRequest): Promise<CallResult> {
  if (!isAddress(req.to)) {
    throw new Error(`invalid address: ${req.to}`);
  }
  const provider = new JsonRpcProvider(req.rpcUrl);
  try {
    // Same pre-check as sendTransaction — see explanation there.
    const code = await provider.getCode(req.to);
    if (!code || code === '0x') {
      throw new Error(
        `No contract found at ${req.to} on this network. ` +
          `Was this deployed to a different network?`
      );
    }
    const contract = new Contract(req.to, req.abi as InterfaceAbi, provider);
    const fn = contract.getFunction(req.funcName);
    const overrides: Record<string, bigint> = {};
    if (req.value !== undefined) {
      overrides.value = req.value;
    }
    const result = await fn.staticCall(...req.args, overrides);
    return { decoded: serializeForJson(result), raw: '' };
  } finally {
    provider.destroy();
  }
}
