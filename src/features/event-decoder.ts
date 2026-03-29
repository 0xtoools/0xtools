/**
 * Event Decoder — Fetch and decode on-chain event logs.
 *
 * Supports filtering by address, topics, and block range. Pre-registers
 * common ERC-20, ERC-721, ERC-1155, Ownable, Proxy, and Uniswap V2 events
 * for automatic decoding.
 *
 * Uses the RpcProvider for eth_getLogs calls and `js-sha3` for keccak256
 * hashing of event signatures.
 */

import { keccak256 } from 'js-sha3';
import { RpcProvider } from './rpc-provider';

/** Filter criteria for fetching events. */
export interface EventFilter {
  chain: string;
  address?: string;
  topics?: (string | null)[];
  fromBlock?: number | 'latest';
  toBlock?: number | 'latest';
  maxBlocks?: number; // safety limit, default 1000
}

/** A decoded event log entry. */
export interface DecodedEvent {
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  topic0: string;
  eventSignature?: string;
  name?: string;
  args: Array<{
    name: string;
    type: string;
    value: string;
    indexed: boolean;
  }>;
  raw: {
    topics: string[];
    data: string;
  };
}

/** Internal event ABI registration entry. */
interface RegisteredEvent {
  name: string;
  signature: string;
  topic0: string;
  inputs: Array<{ name: string; type: string; indexed: boolean }>;
}

/** Common event definitions — hashes computed once at module load. */
const COMMON_EVENT_DEFS: Array<{
  signature: string;
  inputs: Array<{ name: string; type: string; indexed: boolean }>;
}> = [
  {
    signature: 'Transfer(address,address,uint256)',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    signature: 'Approval(address,address,uint256)',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    signature: 'ApprovalForAll(address,address,bool)',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'approved', type: 'bool', indexed: false },
    ],
  },
  {
    signature: 'TransferSingle(address,address,address,uint256,uint256)',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'id', type: 'uint256', indexed: false },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    signature: 'TransferBatch(address,address,address,uint256[],uint256[])',
    inputs: [
      { name: 'operator', type: 'address', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'ids', type: 'uint256[]', indexed: false },
      { name: 'values', type: 'uint256[]', indexed: false },
    ],
  },
  {
    signature: 'OwnershipTransferred(address,address)',
    inputs: [
      { name: 'previousOwner', type: 'address', indexed: true },
      { name: 'newOwner', type: 'address', indexed: true },
    ],
  },
  {
    signature: 'Upgraded(address)',
    inputs: [{ name: 'implementation', type: 'address', indexed: true }],
  },
  {
    signature: 'Swap(address,uint256,uint256,uint256,uint256,address)',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount0In', type: 'uint256', indexed: false },
      { name: 'amount1In', type: 'uint256', indexed: false },
      { name: 'amount0Out', type: 'uint256', indexed: false },
      { name: 'amount1Out', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true },
    ],
  },
];

/**
 * Pre-computed common events map. Hashed once at module load time,
 * shared across all EventDecoder instances (immutable).
 */
const PRECOMPUTED_COMMON_EVENTS: ReadonlyMap<string, RegisteredEvent> = (() => {
  const map = new Map<string, RegisteredEvent>();
  for (const def of COMMON_EVENT_DEFS) {
    const topic0 = '0x' + keccak256(def.signature);
    const name = def.signature.substring(0, def.signature.indexOf('('));
    map.set(topic0, { name, signature: def.signature, topic0, inputs: def.inputs });
  }
  return map;
})();

export class EventDecoder {
  private rpc: RpcProvider;
  private knownEvents: Map<string, RegisteredEvent>;

  constructor(rpc?: RpcProvider) {
    this.rpc = rpc || new RpcProvider();
    // Start with a copy of the pre-computed common events (no keccak recomputation)
    this.knownEvents = new Map(PRECOMPUTED_COMMON_EVENTS);
  }

  /**
   * Register a known event ABI for decoding.
   *
   * @param signature - Event signature (e.g. "Transfer(address,address,uint256)")
   * @param inputs - Array of input definitions with name, type, and indexed flag
   */
  registerEvent(
    signature: string,
    inputs: Array<{ name: string; type: string; indexed: boolean }>
  ): void {
    const topic0 = '0x' + keccak256(signature);
    const name = signature.substring(0, signature.indexOf('('));
    this.knownEvents.set(topic0, {
      name,
      signature,
      topic0,
      inputs,
    });
  }

  /**
   * Register common ERC-20, ERC-721, ERC-1155, Ownable, Proxy, and
   * Uniswap V2 events for automatic decoding.
   * Now a no-op since common events are pre-loaded in the constructor.
   * Kept for API compatibility.
   */
  registerCommonEvents(): void {
    // Common events are pre-computed at module load and loaded in constructor.
    // This method is retained for backwards compatibility but is a no-op.
  }

  /**
   * Fetch and decode events matching the given filter.
   *
   * Applies a safety limit on block range (default 1000 blocks) to prevent
   * overwhelming public RPCs.
   */
  async getEvents(filter: EventFilter): Promise<DecodedEvent[]> {
    const maxBlocks = filter.maxBlocks ?? 1000;

    // Build fromBlock / toBlock hex strings
    let fromBlock: string;
    let toBlock: string;

    if (filter.toBlock === 'latest' || filter.toBlock === undefined) {
      toBlock = 'latest';
    } else {
      toBlock = '0x' + filter.toBlock.toString(16);
    }

    if (filter.fromBlock === 'latest' || filter.fromBlock === undefined) {
      // If both are "latest", just fetch latest block
      fromBlock = 'latest';
    } else {
      fromBlock = '0x' + filter.fromBlock.toString(16);
    }

    // Apply safety limit on block range when both are numeric
    if (
      typeof filter.fromBlock === 'number' &&
      typeof filter.toBlock === 'number' &&
      filter.toBlock - filter.fromBlock > maxBlocks
    ) {
      // Clamp fromBlock to toBlock - maxBlocks
      const clampedFrom = filter.toBlock - maxBlocks;
      fromBlock = '0x' + clampedFrom.toString(16);
    }

    // Build topics array — respect null entries for wildcard matching
    const topics = filter.topics || undefined;

    const logs = await this.rpc.getLogs(filter.chain, {
      address: filter.address,
      topics,
      fromBlock,
      toBlock,
    });

    if (!Array.isArray(logs)) {
      return [];
    }

    return logs.map((log) => this.decodeLog(log));
  }

  /**
   * Decode a single raw log entry.
   *
   * If the topic0 matches a registered event, the log is fully decoded.
   * Otherwise, raw topics and data are returned with basic hex values.
   */
  decodeLog(log: {
    topics: string[];
    data: string;
    address: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
  }): DecodedEvent {
    const topics: string[] = log.topics || [];
    const topic0 = topics[0] || '';
    const blockNumber = log.blockNumber ? Number(BigInt(log.blockNumber)) : 0;
    const logIndex = log.logIndex ? Number(BigInt(log.logIndex)) : 0;

    const decoded: DecodedEvent = {
      address: log.address || '',
      blockNumber,
      transactionHash: log.transactionHash || '',
      logIndex,
      topic0,
      args: [],
      raw: {
        topics,
        data: log.data || '0x',
      },
    };

    // Look up registered event by topic0
    const registered = this.knownEvents.get(topic0);
    if (!registered) {
      // Unknown event — provide raw word breakdowns as args
      const dataWords = this.splitDataWords(log.data || '0x');
      for (let i = 1; i < topics.length; i++) {
        decoded.args.push({
          name: `topic${i}`,
          type: 'bytes32',
          value: topics[i],
          indexed: true,
        });
      }
      for (let i = 0; i < dataWords.length; i++) {
        decoded.args.push({
          name: `data${i}`,
          type: 'bytes32',
          value: '0x' + dataWords[i],
          indexed: false,
        });
      }
      return decoded;
    }

    decoded.eventSignature = registered.signature;
    decoded.name = registered.name;

    // Decode args using registered event schema
    let topicIndex = 1;
    const dataWords = this.splitDataWords(log.data || '0x');
    let dataIndex = 0;

    for (const input of registered.inputs) {
      if (input.indexed) {
        const topicValue = topics[topicIndex] || '';
        decoded.args.push({
          name: input.name,
          type: input.type,
          value: this.decodeValue(topicValue, input.type),
          indexed: true,
        });
        topicIndex++;
      } else {
        const word = dataWords[dataIndex] || '';
        decoded.args.push({
          name: input.name,
          type: input.type,
          value: word ? this.decodeValue('0x' + word, input.type) : '',
          indexed: false,
        });
        dataIndex++;
      }
    }

    return decoded;
  }

  /** Generate a markdown report of decoded events. */
  generateReport(events: DecodedEvent[], filter: EventFilter): string {
    const lines: string[] = [];

    lines.push('# Event Log Report');
    lines.push('');

    const chainConfig = this.rpc.getChain(filter.chain);
    const chainName = chainConfig?.name || filter.chain;
    lines.push(`**Chain:** ${chainName}`);
    if (filter.address) {
      lines.push(`**Address:** \`${filter.address}\``);
    }
    lines.push(`**Events Found:** ${events.length}`);
    lines.push('');

    if (events.length === 0) {
      lines.push('No events found matching the filter criteria.');
      return lines.join('\n');
    }

    // Group events by name
    const grouped = new Map<string, DecodedEvent[]>();
    for (const event of events) {
      const key = event.name || event.topic0.substring(0, 10);
      const list = grouped.get(key) || [];
      list.push(event);
      grouped.set(key, list);
    }

    for (const [name, group] of grouped) {
      lines.push(`## ${name} (${group.length})`);
      lines.push('');

      for (const event of group) {
        lines.push(`### Block ${event.blockNumber.toLocaleString()} | Log #${event.logIndex}`);
        lines.push('');
        lines.push(`- **Tx:** \`${event.transactionHash}\``);
        lines.push(`- **Contract:** \`${event.address}\``);

        if (event.eventSignature) {
          lines.push(`- **Signature:** \`${event.eventSignature}\``);
        }

        if (event.args.length > 0) {
          lines.push('');
          lines.push('| Name | Type | Value | Indexed |');
          lines.push('|------|------|-------|---------|');
          for (const arg of event.args) {
            const truncVal = arg.value.length > 66 ? arg.value.substring(0, 63) + '...' : arg.value;
            lines.push(
              `| ${arg.name} | ${arg.type} | \`${truncVal}\` | ${arg.indexed ? 'yes' : 'no'} |`
            );
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ---- Private Helpers ----

  /** Split hex data into 32-byte words. */
  private splitDataWords(data: string): string[] {
    const hex = data.startsWith('0x') ? data.substring(2) : data;
    if (!hex || hex.length === 0) {
      return [];
    }
    const words: string[] = [];
    for (let i = 0; i < hex.length; i += 64) {
      const word = hex.substring(i, i + 64);
      if (word.length > 0) {
        words.push(word.padEnd(64, '0'));
      }
    }
    return words;
  }

  /**
   * Decode a single hex value based on the expected Solidity type.
   *
   * For indexed dynamic types (string, bytes, arrays), the topic contains
   * a keccak256 hash rather than the actual value — we return the raw hash
   * in those cases.
   */
  private decodeValue(hex: string, type: string): string {
    const raw = hex.startsWith('0x') ? hex.substring(2) : hex;
    const padded = raw.padStart(64, '0');

    if (type === 'address') {
      return '0x' + padded.substring(24);
    }
    if (type === 'bool') {
      return BigInt('0x' + padded) === 0n ? 'false' : 'true';
    }
    if (type.startsWith('uint')) {
      return BigInt('0x' + padded).toString();
    }
    if (type.startsWith('int')) {
      // Signed integer: check high bit
      const unsigned = BigInt('0x' + padded);
      const bits = parseInt(type.replace('int', '') || '256', 10);
      const max = 1n << BigInt(bits);
      const half = max >> 1n;
      if (unsigned >= half) {
        return (unsigned - max).toString();
      }
      return unsigned.toString();
    }
    if (type.startsWith('bytes')) {
      return '0x' + padded;
    }
    // Dynamic types or unknown — return raw hex
    return '0x' + padded;
  }
}
