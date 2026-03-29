/**
 * Chain Explorer — Contract state reader with storage decoding, call
 * simulation, and ABI encoding utilities.
 *
 * Provides read-only interactions with deployed contracts: simulate calls
 * (eth_call), read raw storage slots, decode Solidity mappings and dynamic
 * arrays, query ERC-20 token balances, and inspect block metadata.
 *
 * Uses `js-sha3` for keccak256 hashing and the RpcProvider for all RPC
 * calls. No external HTTP or ABI libraries required.
 */

import { keccak256 } from 'js-sha3';
import { RpcProvider } from './rpc-provider';

/** Full contract state snapshot. */
export interface ContractState {
  address: string;
  chain: string;
  balance: string;
  code: string;
  codeSize: number;
  storageValues: Map<string, string>;
}

/** Result of a simulated eth_call. */
export interface CallResult {
  success: boolean;
  data: string;
  decoded?: Array<{ type: string; value: string }>;
  gasUsed?: number;
}

/** Cached ERC20 token metadata (symbol + decimals are immutable). */
interface TokenMeta {
  symbol: string;
  decimals: number;
}

export class ChainExplorer {
  private rpc: RpcProvider;
  /** Permanent cache for ERC20 metadata keyed by "chain:tokenAddress". */
  private tokenMetaCache: Map<string, TokenMeta>;

  constructor(rpc?: RpcProvider) {
    this.rpc = rpc || new RpcProvider();
    this.tokenMetaCache = new Map();
  }

  /**
   * Simulate a contract call (eth_call) without sending a transaction.
   *
   * Returns the raw return data and a best-effort decode if the result
   * looks like it contains standard ABI-encoded words.
   */
  async simulateCall(
    chain: string,
    options: {
      to: string;
      data: string;
      from?: string;
      value?: string;
      block?: string;
    }
  ): Promise<CallResult> {
    const callObj: any = {
      to: options.to,
      data: options.data,
    };
    if (options.from) {
      callObj.from = options.from;
    }
    if (options.value) {
      callObj.value = options.value;
    }

    try {
      const result = await this.rpc.call(chain, 'eth_call', [callObj, options.block || 'latest']);

      const decoded = this.decodeReturnData(result);

      return {
        success: true,
        data: result,
        decoded,
      };
    } catch (error: any) {
      return {
        success: false,
        data: error.message || 'eth_call reverted',
      };
    }
  }

  /**
   * Encode a function call from a signature and arguments.
   *
   * Supports basic Solidity types: address, uint256/uint*, int256/int*,
   * bool, bytes32/bytes*, and string. Returns "0x" + 4-byte selector +
   * ABI-encoded arguments.
   *
   * @param functionSig - e.g. "balanceOf(address)" or "transfer(address,uint256)"
   * @param args - String representations of each argument in order
   */
  encodeCall(functionSig: string, args: string[]): string {
    // Compute 4-byte selector
    const selector = keccak256(functionSig).substring(0, 8);

    // Parse parameter types from signature
    const paramTypes = this.parseParamTypes(functionSig);

    // ABI-encode each argument
    let encoded = '';
    for (let i = 0; i < paramTypes.length; i++) {
      const type = paramTypes[i];
      const arg = i < args.length ? args[i] : '0';
      encoded += this.abiEncodeValue(arg, type);
    }

    return '0x' + selector + encoded;
  }

  /** Read a specific storage slot (hex or decimal). */
  async readSlot(chain: string, address: string, slot: string | number): Promise<string> {
    const slotHex = typeof slot === 'number' ? '0x' + slot.toString(16) : slot;
    return await this.rpc.getStorageAt(chain, address.toLowerCase(), slotHex);
  }

  /**
   * Read a mapping value.
   *
   * Solidity stores mapping values at keccak256(abi.encode(key, mappingSlot)).
   * The key is left-padded to 32 bytes and concatenated with the slot
   * (also 32 bytes), then hashed.
   */
  async readMapping(
    chain: string,
    address: string,
    mappingSlot: number,
    key: string
  ): Promise<string> {
    const keyPadded = this.padTo32Bytes(key);
    const slotPadded = mappingSlot.toString(16).padStart(64, '0');

    // keccak256(abi.encode(key, slot))
    const preimage = keyPadded + slotPadded;
    const hash = '0x' + keccak256(Buffer.from(preimage, 'hex'));

    return await this.rpc.getStorageAt(chain, address.toLowerCase(), hash);
  }

  /**
   * Read a dynamic array's length and first N elements.
   *
   * In Solidity, the array length is stored at the slot itself.
   * Elements start at keccak256(slot) and are sequential.
   */
  async readArray(chain: string, address: string, slot: number, count?: number): Promise<string[]> {
    const normalizedAddr = address.toLowerCase();

    // Read length from the slot
    const lengthHex = await this.rpc.getStorageAt(chain, normalizedAddr, '0x' + slot.toString(16));
    const length = Number(BigInt(lengthHex));

    if (length === 0) {
      return [];
    }

    // Elements start at keccak256(slot)
    const slotPadded = slot.toString(16).padStart(64, '0');
    const baseSlot = BigInt('0x' + keccak256(Buffer.from(slotPadded, 'hex')));

    const readCount = count !== undefined ? Math.min(count, length) : Math.min(length, 20);
    const results: string[] = [];

    // Fetch elements in parallel
    const promises: Promise<string>[] = [];
    for (let i = 0; i < readCount; i++) {
      const elementSlot = '0x' + (baseSlot + BigInt(i)).toString(16);
      promises.push(this.rpc.getStorageAt(chain, normalizedAddr, elementSlot));
    }

    const values = await Promise.all(promises);
    for (const val of values) {
      results.push(val);
    }

    return results;
  }

  /** Get contract balance in native currency (human-readable). */
  async getBalance(chain: string, address: string): Promise<string> {
    const balanceWei = await this.rpc.getBalance(chain, address.toLowerCase());
    return this.rpc.formatValue(balanceWei, chain);
  }

  /**
   * Get ERC-20 token balance for a holder address.
   *
   * Calls balanceOf(address), decimals(), and symbol() on the token contract,
   * then formats the balance with the correct number of decimal places.
   */
  async getTokenBalance(
    chain: string,
    tokenAddress: string,
    holderAddress: string
  ): Promise<{ raw: string; formatted: string; decimals: number; symbol: string }> {
    const normalizedToken = tokenAddress.toLowerCase();
    const normalizedHolder = holderAddress.toLowerCase();
    const metaCacheKey = `${chain}:${normalizedToken}`;

    // Check if we have cached token metadata (symbol + decimals are immutable)
    let meta = this.tokenMetaCache.get(metaCacheKey);

    // Encode balance call (always needed — balances change)
    const balanceOfData = this.encodeCall('balanceOf(address)', [normalizedHolder]);

    let rawBalance: bigint;

    if (meta) {
      // Metadata cached — only fetch balance
      const balanceResult = await this.rpc
        .ethCall(chain, normalizedToken, balanceOfData)
        .catch(() => '0x0');
      rawBalance = balanceResult && balanceResult !== '0x' ? BigInt(balanceResult) : 0n;
    } else {
      // Fetch all three in parallel
      const decimalsData = this.encodeCall('decimals()', []);
      const symbolData = this.encodeCall('symbol()', []);

      const [balanceResult, decimalsResult, symbolResult] = await Promise.all([
        this.rpc.ethCall(chain, normalizedToken, balanceOfData).catch(() => '0x0'),
        this.rpc.ethCall(chain, normalizedToken, decimalsData).catch(() => '0x12'),
        this.rpc.ethCall(chain, normalizedToken, symbolData).catch(() => '0x'),
      ]);

      rawBalance = balanceResult && balanceResult !== '0x' ? BigInt(balanceResult) : 0n;
      const decimals =
        decimalsResult && decimalsResult !== '0x' ? Number(BigInt(decimalsResult)) : 18;
      const symbol = this.decodeAbiString(symbolResult) || 'UNKNOWN';

      meta = { symbol, decimals };
      this.tokenMetaCache.set(metaCacheKey, meta);
    }

    // Format balance with decimals
    const formatted = this.formatTokenAmount(rawBalance, meta.decimals);

    return {
      raw: rawBalance.toString(),
      formatted: `${formatted} ${meta.symbol}`,
      decimals: meta.decimals,
      symbol: meta.symbol,
    };
  }

  /** Get current block info. */
  async getCurrentBlock(
    chain: string
  ): Promise<{ number: number; timestamp: number; gasLimit: string; baseFee?: string }> {
    const block = await this.rpc.getBlock(chain, 'latest');

    if (!block) {
      throw new Error(`Failed to fetch latest block on ${chain}`);
    }

    return {
      number: block.number ? Number(BigInt(block.number)) : 0,
      timestamp: block.timestamp ? Number(BigInt(block.timestamp)) : 0,
      gasLimit: block.gasLimit ? BigInt(block.gasLimit).toString() : '0',
      baseFee: block.baseFeePerGas
        ? (Number(BigInt(block.baseFeePerGas)) / 1e9).toFixed(4) + ' Gwei'
        : undefined,
    };
  }

  /** Generate a markdown report for a contract state snapshot. */
  generateReport(state: ContractState): string {
    const lines: string[] = [];

    const chainConfig = this.rpc.getChain(state.chain);
    const chainName = chainConfig?.name || state.chain;

    lines.push('# Contract State Report');
    lines.push('');
    lines.push(`**Address:** \`${state.address}\``);
    lines.push(`**Chain:** ${chainName}`);
    lines.push(`**Balance:** ${state.balance}`);
    lines.push(`**Code Size:** ${state.codeSize.toLocaleString()} bytes`);
    lines.push('');

    // Storage values
    if (state.storageValues.size > 0) {
      lines.push('## Storage');
      lines.push('');
      lines.push('| Slot | Value |');
      lines.push('|------|-------|');

      for (const [slot, value] of state.storageValues) {
        const isZero = value === '0x' + '0'.repeat(64);
        const display = isZero ? '(empty)' : `\`${value}\``;
        lines.push(`| ${slot} | ${display} |`);
      }
      lines.push('');
    }

    // Bytecode preview
    if (state.code && state.code.length > 2) {
      lines.push('## Bytecode');
      lines.push('');
      const preview =
        state.code.length > 200
          ? state.code.substring(0, 200) + `... (${(state.code.length - 2) / 2} bytes total)`
          : state.code;
      lines.push(`\`\`\`\n${preview}\n\`\`\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---- Private Helpers ----

  /**
   * Parse parameter types from a function signature.
   * E.g. "transfer(address,uint256)" -> ["address", "uint256"]
   */
  private parseParamTypes(signature: string): string[] {
    const match = signature.match(/\(([^)]*)\)/);
    if (!match || !match[1]) {
      return [];
    }

    const inner = match[1];
    if (!inner.trim()) {
      return [];
    }

    // Handle nested tuples by tracking paren depth
    const result: string[] = [];
    let current = '';
    let depth = 0;
    for (const ch of inner) {
      if (ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ')') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        if (current.trim()) {
          result.push(current.trim());
        }
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      result.push(current.trim());
    }
    return result;
  }

  /**
   * ABI-encode a single value to a 32-byte word (64 hex chars).
   *
   * Supports address, uint*, int*, bool, bytes32, and string (simple cases).
   */
  private abiEncodeValue(value: string, type: string): string {
    if (type === 'address') {
      // Remove 0x, pad to 32 bytes on the left
      const addr = value.startsWith('0x') ? value.substring(2) : value;
      return addr.toLowerCase().padStart(64, '0');
    }

    if (type === 'bool') {
      const boolVal = value === 'true' || value === '1' ? '1' : '0';
      return boolVal.padStart(64, '0');
    }

    if (type.startsWith('uint')) {
      const n = BigInt(value);
      return n.toString(16).padStart(64, '0');
    }

    if (type.startsWith('int')) {
      let n = BigInt(value);
      if (n < 0n) {
        // Two's complement for 256-bit
        n = (1n << 256n) + n;
      }
      return n.toString(16).padStart(64, '0');
    }

    if (type === 'bytes32') {
      const hex = value.startsWith('0x') ? value.substring(2) : value;
      return hex.padEnd(64, '0').substring(0, 64);
    }

    if (type.startsWith('bytes') && !type.includes('[]')) {
      const hex = value.startsWith('0x') ? value.substring(2) : value;
      return hex.padEnd(64, '0').substring(0, 64);
    }

    if (type === 'string') {
      // Simple inline ABI encoding for short strings
      // For dynamic types in a real ABI encoder we'd use an offset,
      // but for calldata encoding of a single-param call this works.
      const hexStr = Buffer.from(value, 'utf8').toString('hex');
      const len = value.length.toString(16).padStart(64, '0');
      const paddedData = hexStr.padEnd(Math.ceil(hexStr.length / 64) * 64, '0');
      // offset (32 bytes pointing to the start of the dynamic data)
      const offset = (32).toString(16).padStart(64, '0');
      return offset + len + paddedData;
    }

    // Fallback: treat as uint256
    try {
      const n = BigInt(value);
      return n.toString(16).padStart(64, '0');
    } catch {
      // Last resort: pad hex
      const hex = value.startsWith('0x') ? value.substring(2) : value;
      return hex.padStart(64, '0');
    }
  }

  /**
   * Pad a value to 32 bytes (64 hex chars) for storage slot computation.
   *
   * Addresses are left-padded; numbers are converted to hex and left-padded.
   */
  private padTo32Bytes(value: string): string {
    if (value.startsWith('0x')) {
      const hex = value.substring(2);
      return hex.padStart(64, '0');
    }

    // Try as number
    try {
      const n = BigInt(value);
      return n.toString(16).padStart(64, '0');
    } catch {
      // Treat as hex
      return value.padStart(64, '0');
    }
  }

  /**
   * Attempt to decode raw return data into typed values.
   *
   * If the data is a multiple of 32 bytes, splits into words and
   * attempts to identify addresses and numbers.
   */
  private decodeReturnData(data: string): Array<{ type: string; value: string }> | undefined {
    if (!data || data === '0x' || data.length <= 2) {
      return undefined;
    }

    const hex = data.startsWith('0x') ? data.substring(2) : data;
    if (hex.length === 0 || hex.length % 64 !== 0) {
      return undefined;
    }

    const words: Array<{ type: string; value: string }> = [];
    for (let i = 0; i < hex.length; i += 64) {
      const word = hex.substring(i, i + 64);
      // Heuristic: if upper 12 bytes are zero and lower 20 bytes non-zero, likely address
      const upper = word.substring(0, 24);
      const lower = word.substring(24);
      if (upper === '0'.repeat(24) && lower !== '0'.repeat(40)) {
        words.push({ type: 'address', value: '0x' + lower });
      } else {
        words.push({ type: 'uint256', value: BigInt('0x' + word).toString() });
      }
    }

    return words;
  }

  /**
   * Decode an ABI-encoded string from eth_call return data.
   *
   * Standard ABI encoding for a string return:
   *   [0x00..0x1f] offset (32 bytes) — usually 0x20
   *   [0x20..0x3f] length (32 bytes)
   *   [0x40..    ] UTF-8 data padded to 32-byte boundary
   */
  private decodeAbiString(data: string): string | null {
    if (!data || data === '0x' || data.length < 130) {
      // 130 = 0x + 64 (offset) + 64 (length) + at least some data
      // But handle edge case of empty string
      if (data && data.length === 130) {
        // Offset + length, length might be 0
        const hex = data.substring(2);
        const lengthWord = hex.substring(64, 128);
        const strLength = Number(BigInt('0x' + lengthWord));
        if (strLength === 0) {
          return '';
        }
      }
      return null;
    }

    try {
      const hex = data.startsWith('0x') ? data.substring(2) : data;

      // Read offset
      const offset = Number(BigInt('0x' + hex.substring(0, 64)));
      const offsetBytes = offset * 2; // convert to hex char offset

      // Read length at offset
      const lengthStart = offsetBytes;
      if (lengthStart + 64 > hex.length) {
        return null;
      }
      const strLength = Number(BigInt('0x' + hex.substring(lengthStart, lengthStart + 64)));

      if (strLength === 0) {
        return '';
      }

      // Read string data
      const dataStart = lengthStart + 64;
      const dataHex = hex.substring(dataStart, dataStart + strLength * 2);

      // Convert hex to UTF-8
      const bytes: number[] = [];
      for (let i = 0; i < dataHex.length; i += 2) {
        bytes.push(parseInt(dataHex.substring(i, i + 2), 16));
      }

      return Buffer.from(bytes).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Format a token amount with the given number of decimal places.
   *
   * Handles arbitrary precision by using BigInt arithmetic.
   */
  private formatTokenAmount(amount: bigint, decimals: number): string {
    if (amount === 0n) {
      return '0';
    }

    const divisor = 10n ** BigInt(decimals);
    const wholePart = amount / divisor;
    const fracPart = amount % divisor;

    if (fracPart === 0n) {
      return wholePart.toString();
    }

    let fracStr = fracPart.toString().padStart(decimals, '0');
    fracStr = fracStr.replace(/0+$/, '');

    // Limit to 8 significant decimal digits
    if (fracStr.length > 8) {
      fracStr = fracStr.substring(0, 8);
    }

    return `${wholePart.toString()}.${fracStr}`;
  }
}
