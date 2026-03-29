/**
 * Transaction Inspector — Fetch and decode everything about an EVM transaction.
 *
 * Given a transaction hash and chain name, retrieves the transaction data,
 * receipt, block timestamp, and attempts to decode calldata and event logs
 * using the 4byte.directory API.
 *
 * Uses the RpcProvider for all on-chain data and FourByteLookup for selector
 * resolution. No external HTTP dependencies beyond what those modules use.
 */

import { RpcProvider } from './rpc-provider';
import { FourByteLookup } from './four-byte-lookup';

/** Fully-hydrated transaction details. */
export interface TransactionDetails {
  hash: string;
  chain: string;
  status: 'success' | 'reverted' | 'pending';
  blockNumber: number | null;
  timestamp: number | null;
  from: string;
  to: string | null;
  value: string;
  valueWei: string;
  gasUsed: number;
  gasLimit: number;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFee?: string;
  nonce: number;
  input: string;
  decodedInput?: {
    functionName: string;
    selector: string;
    args: Array<{ name: string; type: string; value: string }>;
  };
  events: Array<{
    address: string;
    name?: string;
    topic0: string;
    topics: string[];
    data: string;
    decodedArgs?: Array<{ name: string; type: string; value: string; indexed: boolean }>;
    logIndex: number;
  }>;
  internalCalls: Array<{
    type: string;
    from: string;
    to: string;
    value: string;
    gasUsed: number;
  }>;
  contractCreated?: string;
  cost: string;
  effectiveGasPrice: string;
}

export class TxInspector {
  private rpc: RpcProvider;
  private fourByte: FourByteLookup;
  private signatureCache: Map<string, string>;

  constructor(rpc?: RpcProvider) {
    this.rpc = rpc || new RpcProvider();
    this.fourByte = new FourByteLookup();
    this.signatureCache = new Map();
  }

  /** Fetch and decode a transaction. */
  async inspect(txHash: string, chain: string): Promise<TransactionDetails> {
    // Fetch tx and receipt in parallel
    const [tx, receipt] = await Promise.all([
      this.rpc.getTransaction(chain, txHash),
      this.rpc.getTransactionReceipt(chain, txHash),
    ]);

    if (!tx) {
      throw new Error(`Transaction ${txHash} not found on ${chain}`);
    }

    // Determine status
    let status: TransactionDetails['status'] = 'pending';
    if (receipt) {
      status = receipt.status === '0x1' ? 'success' : 'reverted';
    }

    // Fetch block timestamp if mined
    let timestamp: number | null = null;
    const blockNumber = tx.blockNumber ? Number(BigInt(tx.blockNumber)) : null;
    if (tx.blockNumber) {
      try {
        const block = await this.rpc.getBlock(chain, tx.blockNumber);
        if (block && block.timestamp) {
          timestamp = Number(BigInt(block.timestamp));
        }
      } catch {
        // Non-critical — leave timestamp null
      }
    }

    // Parse values
    const valueWei = tx.value ? BigInt(tx.value) : 0n;
    const gasLimit = tx.gas ? Number(BigInt(tx.gas)) : 0;
    const gasUsed = receipt?.gasUsed ? Number(BigInt(receipt.gasUsed)) : 0;
    const nonce = tx.nonce ? Number(BigInt(tx.nonce)) : 0;

    // Gas pricing
    const effectiveGasPriceWei = receipt?.effectiveGasPrice
      ? BigInt(receipt.effectiveGasPrice)
      : tx.gasPrice
        ? BigInt(tx.gasPrice)
        : 0n;

    const gasPriceGwei = this.weiToGwei(tx.gasPrice ? BigInt(tx.gasPrice) : 0n);
    const effectiveGasPriceGwei = this.weiToGwei(effectiveGasPriceWei);

    // Total cost
    const costWei = effectiveGasPriceWei * BigInt(gasUsed);
    const costFormatted = this.rpc.formatValue(costWei, chain);

    // EIP-1559 fields
    let maxFeePerGas: string | undefined;
    let maxPriorityFee: string | undefined;
    if (tx.maxFeePerGas) {
      maxFeePerGas = this.weiToGwei(BigInt(tx.maxFeePerGas));
    }
    if (tx.maxPriorityFeePerGas) {
      maxPriorityFee = this.weiToGwei(BigInt(tx.maxPriorityFeePerGas));
    }

    // Decode calldata
    let decodedInput: TransactionDetails['decodedInput'] | undefined;
    if (tx.input && tx.input.length >= 10 && tx.input !== '0x') {
      const selector = tx.input.substring(0, 10);
      const decoded = await this.decodeCalldata(selector, tx.input);
      if (decoded) {
        decodedInput = decoded;
      }
    }

    // Decode events
    const events: TransactionDetails['events'] = [];
    if (receipt?.logs && Array.isArray(receipt.logs)) {
      for (const log of receipt.logs) {
        const decoded = await this.decodeEvent(log);
        events.push(decoded);
      }
    }

    // Contract creation
    let contractCreated: string | undefined;
    if (receipt?.contractAddress) {
      contractCreated = receipt.contractAddress;
    }

    return {
      hash: txHash,
      chain,
      status,
      blockNumber,
      timestamp,
      from: tx.from || '',
      to: tx.to || null,
      value: this.rpc.formatValue(valueWei, chain),
      valueWei: valueWei.toString(),
      gasUsed,
      gasLimit,
      gasPrice: gasPriceGwei,
      maxFeePerGas,
      maxPriorityFee,
      nonce,
      input: tx.input || '0x',
      decodedInput,
      events,
      internalCalls: [], // Internal calls require debug_traceTransaction which most public RPCs don't support
      contractCreated,
      cost: costFormatted,
      effectiveGasPrice: effectiveGasPriceGwei,
    };
  }

  /** Try to decode calldata using known 4-byte signatures. */
  async decodeCalldata(
    selector: string,
    data: string
  ): Promise<TransactionDetails['decodedInput'] | null> {
    // Check local cache first
    let functionName = this.signatureCache.get(selector);

    if (!functionName) {
      try {
        const signatures = await this.fourByte.lookup(selector);
        if (signatures.length > 0) {
          functionName = signatures[0]; // Use most popular match
          this.signatureCache.set(selector, functionName);
        }
      } catch {
        // Lookup failed — non-critical
      }
    }

    if (!functionName) {
      // Return raw selector info without decoded name
      const args = this.splitCalldataWords(data.substring(10));
      return {
        functionName: `unknown_${selector}`,
        selector,
        args: args.map((word, i) => ({
          name: `arg${i}`,
          type: 'bytes32',
          value: '0x' + word,
        })),
      };
    }

    // Parse parameter types from signature
    const paramTypes = this.parseParamTypes(functionName);
    const rawWords = this.splitCalldataWords(data.substring(10));

    const args: Array<{ name: string; type: string; value: string }> = [];
    for (let i = 0; i < paramTypes.length && i < rawWords.length; i++) {
      args.push({
        name: `param${i}`,
        type: paramTypes[i],
        value: this.decodeWord(rawWords[i], paramTypes[i]),
      });
    }

    return {
      functionName,
      selector,
      args,
    };
  }

  /** Try to decode an event log using known topic signatures. */
  async decodeEvent(log: any): Promise<TransactionDetails['events'][0]> {
    const topics: string[] = log.topics || [];
    const topic0 = topics[0] || '';
    const logIndex = log.logIndex ? Number(BigInt(log.logIndex)) : 0;

    const event: TransactionDetails['events'][0] = {
      address: log.address || '',
      topic0,
      topics,
      data: log.data || '0x',
      logIndex,
    };

    if (!topic0) {
      return event;
    }

    // Try 4byte event lookup
    // The 4byte.directory uses the full 32-byte topic for events,
    // but its API primarily covers function selectors. We'll try with the
    // first 10 chars (4 bytes) as a heuristic, and also use a known events map.
    const knownEventName = KNOWN_EVENT_TOPICS.get(topic0);
    if (knownEventName) {
      event.name = knownEventName.name;
      event.decodedArgs = this.decodeEventArgs(knownEventName, topics, log.data || '0x');
    }

    return event;
  }

  /** Generate a detailed markdown report. */
  generateReport(tx: TransactionDetails): string {
    const lines: string[] = [];

    lines.push('# Transaction Details');
    lines.push('');
    lines.push(`**Hash:** \`${tx.hash}\``);

    const statusIcon =
      tx.status === 'success' ? 'Success' : tx.status === 'reverted' ? 'Reverted' : 'Pending';
    const statusEmoji =
      tx.status === 'success' ? '(ok)' : tx.status === 'reverted' ? '(failed)' : '(pending)';
    lines.push(`**Status:** ${statusEmoji} ${statusIcon}`);

    const chainConfig = this.rpc.getChain(tx.chain);
    const chainName = chainConfig?.name || tx.chain;
    lines.push(
      `**Block:** ${tx.blockNumber !== null ? tx.blockNumber.toLocaleString() : 'Pending'} | **Chain:** ${chainName}`
    );

    if (tx.timestamp) {
      lines.push(`**Timestamp:** ${new Date(tx.timestamp * 1000).toISOString()}`);
    }
    lines.push('');

    // Addresses
    lines.push('## Addresses');
    lines.push('');
    lines.push('| Role | Address |');
    lines.push('|------|---------|');
    lines.push(`| From | \`${tx.from}\` |`);
    if (tx.to) {
      lines.push(`| To | \`${tx.to}\` |`);
    }
    if (tx.contractCreated) {
      lines.push(`| Contract Created | \`${tx.contractCreated}\` |`);
    }
    lines.push('');

    // Value Transfer
    lines.push('## Value Transfer');
    lines.push('');
    lines.push(`- **Value:** ${tx.value}`);
    const gasPercent = tx.gasLimit > 0 ? ((tx.gasUsed / tx.gasLimit) * 100).toFixed(1) : '0';
    lines.push(
      `- **Gas Used:** ${tx.gasUsed.toLocaleString()} / ${tx.gasLimit.toLocaleString()} (${gasPercent}%)`
    );
    lines.push(`- **Gas Price:** ${tx.gasPrice} Gwei`);
    if (tx.maxFeePerGas) {
      lines.push(`- **Max Fee Per Gas:** ${tx.maxFeePerGas} Gwei`);
    }
    if (tx.maxPriorityFee) {
      lines.push(`- **Max Priority Fee:** ${tx.maxPriorityFee} Gwei`);
    }
    lines.push(`- **Effective Gas Price:** ${tx.effectiveGasPrice} Gwei`);
    lines.push(`- **Total Cost:** ${tx.cost}`);
    lines.push(`- **Nonce:** ${tx.nonce}`);
    lines.push('');

    // Decoded Input
    if (tx.decodedInput) {
      lines.push('## Decoded Input');
      lines.push('');
      lines.push(`**Function:** \`${tx.decodedInput.functionName}\``);
      lines.push(`**Selector:** \`${tx.decodedInput.selector}\``);
      lines.push('');

      if (tx.decodedInput.args.length > 0) {
        lines.push('| # | Type | Value |');
        lines.push('|---|------|-------|');
        for (let i = 0; i < tx.decodedInput.args.length; i++) {
          const arg = tx.decodedInput.args[i];
          const truncatedValue =
            arg.value.length > 80 ? arg.value.substring(0, 77) + '...' : arg.value;
          lines.push(`| ${i} | ${arg.type} | \`${truncatedValue}\` |`);
        }
        lines.push('');
      }
    } else if (tx.input && tx.input !== '0x' && tx.input.length > 2) {
      lines.push('## Raw Input');
      lines.push('');
      const truncated = tx.input.length > 200 ? tx.input.substring(0, 200) + '...' : tx.input;
      lines.push(`\`${truncated}\``);
      lines.push('');
    }

    // Events
    if (tx.events.length > 0) {
      lines.push(`## Events (${tx.events.length})`);
      lines.push('');

      for (const event of tx.events) {
        const eventTitle = event.name || `Event(${event.topic0.substring(0, 10)}...)`;
        lines.push(`### ${eventTitle}`);
        lines.push('');
        lines.push(`- **Contract:** \`${event.address}\``);
        lines.push(`- **Log Index:** ${event.logIndex}`);

        if (event.decodedArgs && event.decodedArgs.length > 0) {
          lines.push('');
          lines.push('| Name | Type | Value | Indexed |');
          lines.push('|------|------|-------|---------|');
          for (const arg of event.decodedArgs) {
            const truncVal = arg.value.length > 66 ? arg.value.substring(0, 63) + '...' : arg.value;
            lines.push(
              `| ${arg.name} | ${arg.type} | \`${truncVal}\` | ${arg.indexed ? 'yes' : 'no'} |`
            );
          }
        } else {
          lines.push(`- **Topic0:** \`${event.topic0}\``);
          if (event.data && event.data !== '0x') {
            const truncData =
              event.data.length > 130 ? event.data.substring(0, 130) + '...' : event.data;
            lines.push(`- **Data:** \`${truncData}\``);
          }
        }
        lines.push('');
      }
    }

    // Internal calls
    if (tx.internalCalls.length > 0) {
      lines.push('## Internal Calls');
      lines.push('');
      lines.push('| Type | From | To | Value | Gas |');
      lines.push('|------|------|----|-------|-----|');
      for (const ic of tx.internalCalls) {
        lines.push(
          `| ${ic.type} | \`${ic.from.substring(0, 10)}...\` | \`${ic.to.substring(0, 10)}...\` | ${ic.value} | ${ic.gasUsed.toLocaleString()} |`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---- Private Helpers ----

  /** Convert wei to gwei string (human-readable). */
  private weiToGwei(wei: bigint): string {
    const gwei = Number(wei) / 1e9;
    return gwei.toFixed(4);
  }

  /** Split hex data (without 0x prefix) into 32-byte (64-char) words. */
  private splitCalldataWords(hex: string): string[] {
    const words: string[] = [];
    for (let i = 0; i < hex.length; i += 64) {
      const word = hex.substring(i, i + 64);
      if (word.length > 0) {
        words.push(word.padEnd(64, '0'));
      }
    }
    return words;
  }

  /** Parse parameter types from a function signature string like "transfer(address,uint256)". */
  private parseParamTypes(signature: string): string[] {
    const match = signature.match(/\(([^)]*)\)/);
    if (!match || !match[1]) {
      return [];
    }

    // Handle nested tuples by tracking paren depth
    const result: string[] = [];
    let current = '';
    let depth = 0;
    for (const ch of match[1]) {
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

  /** Decode a single 32-byte word based on the expected type. */
  private decodeWord(word: string, type: string): string {
    if (type === 'address') {
      return '0x' + word.substring(24);
    }
    if (type === 'bool') {
      return BigInt('0x' + word) === 0n ? 'false' : 'true';
    }
    if (type.startsWith('uint') || type.startsWith('int')) {
      return BigInt('0x' + word).toString();
    }
    if (type.startsWith('bytes')) {
      return '0x' + word;
    }
    // Default: return raw hex
    return '0x' + word;
  }

  /** Decode event args from topics and data using known event info. */
  private decodeEventArgs(
    eventInfo: KnownEventInfo,
    topics: string[],
    data: string
  ): Array<{ name: string; type: string; value: string; indexed: boolean }> {
    const args: Array<{ name: string; type: string; value: string; indexed: boolean }> = [];
    let topicIndex = 1; // topic[0] is the event signature
    const dataWords = this.splitCalldataWords(data.startsWith('0x') ? data.substring(2) : data);
    let dataIndex = 0;

    for (const param of eventInfo.params) {
      if (param.indexed) {
        const topicValue = topics[topicIndex] || '';
        const rawHex = topicValue.startsWith('0x') ? topicValue.substring(2) : topicValue;
        args.push({
          name: param.name,
          type: param.type,
          value: rawHex ? this.decodeWord(rawHex.padStart(64, '0'), param.type) : '',
          indexed: true,
        });
        topicIndex++;
      } else {
        const word = dataWords[dataIndex] || '';
        args.push({
          name: param.name,
          type: param.type,
          value: word ? this.decodeWord(word, param.type) : '',
          indexed: false,
        });
        dataIndex++;
      }
    }

    return args;
  }
}

// ---- Known Event Topics ----

interface KnownEventInfo {
  name: string;
  params: Array<{ name: string; type: string; indexed: boolean }>;
}

/**
 * Pre-computed keccak256 hashes of common event signatures.
 * These allow instant decoding without API calls.
 */
const KNOWN_EVENT_TOPICS = new Map<string, KnownEventInfo>();

// We compute these at module load time using js-sha3
function initKnownEvents(): void {
  let keccak256: (data: string) => string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    keccak256 = require('js-sha3').keccak256;
  } catch {
    return; // js-sha3 not available — skip
  }

  const events: Array<{
    signature: string;
    name: string;
    params: KnownEventInfo['params'];
  }> = [
    {
      signature: 'Transfer(address,address,uint256)',
      name: 'Transfer',
      params: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    },
    {
      signature: 'Approval(address,address,uint256)',
      name: 'Approval',
      params: [
        { name: 'owner', type: 'address', indexed: true },
        { name: 'spender', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    },
    {
      signature: 'ApprovalForAll(address,address,bool)',
      name: 'ApprovalForAll',
      params: [
        { name: 'owner', type: 'address', indexed: true },
        { name: 'operator', type: 'address', indexed: true },
        { name: 'approved', type: 'bool', indexed: false },
      ],
    },
    {
      signature: 'OwnershipTransferred(address,address)',
      name: 'OwnershipTransferred',
      params: [
        { name: 'previousOwner', type: 'address', indexed: true },
        { name: 'newOwner', type: 'address', indexed: true },
      ],
    },
    {
      signature: 'Upgraded(address)',
      name: 'Upgraded',
      params: [{ name: 'implementation', type: 'address', indexed: true }],
    },
    {
      signature: 'TransferSingle(address,address,address,uint256,uint256)',
      name: 'TransferSingle',
      params: [
        { name: 'operator', type: 'address', indexed: true },
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'id', type: 'uint256', indexed: false },
        { name: 'value', type: 'uint256', indexed: false },
      ],
    },
    {
      signature: 'TransferBatch(address,address,address,uint256[],uint256[])',
      name: 'TransferBatch',
      params: [
        { name: 'operator', type: 'address', indexed: true },
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'ids', type: 'uint256[]', indexed: false },
        { name: 'values', type: 'uint256[]', indexed: false },
      ],
    },
    {
      signature: 'Swap(address,uint256,uint256,uint256,uint256,address)',
      name: 'Swap',
      params: [
        { name: 'sender', type: 'address', indexed: true },
        { name: 'amount0In', type: 'uint256', indexed: false },
        { name: 'amount1In', type: 'uint256', indexed: false },
        { name: 'amount0Out', type: 'uint256', indexed: false },
        { name: 'amount1Out', type: 'uint256', indexed: false },
        { name: 'to', type: 'address', indexed: true },
      ],
    },
  ];

  for (const evt of events) {
    const hash = '0x' + keccak256(evt.signature);
    KNOWN_EVENT_TOPICS.set(hash, { name: evt.name, params: evt.params });
  }
}

// Initialize known events on module load
initKnownEvents();
