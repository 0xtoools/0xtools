/**
 * Address Inspector — Inspect any address on any supported EVM chain.
 *
 * Determines whether an address is an EOA or a contract, retrieves balance,
 * nonce, bytecode, and probes for EIP-1967 proxy patterns. Storage slots
 * can be read individually or in ranges.
 *
 * Uses the RpcProvider for all on-chain queries. No external dependencies
 * beyond what RpcProvider provides.
 */

import { RpcProvider } from './rpc-provider';

/** Full inspection result for an address. */
export interface AddressInfo {
  address: string;
  chain: string;
  type: 'eoa' | 'contract';
  balance: string;
  balanceWei: string;
  nonce: number;
  transactionCount: number;
  code?: string;
  codeSize?: number;
  storageSlots?: Array<{ slot: string; value: string }>;
  isProxy?: boolean;
  implementationAddress?: string;
}

/**
 * EIP-1967 well-known storage slots.
 *
 * - Implementation: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
 * - Admin:          bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
 * - Beacon:         bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)
 */
const EIP1967_SLOTS = {
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
};

/** Zero address constant for comparison. */
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

export class AddressInspector {
  private rpc: RpcProvider;
  private proxyCache: Map<
    string,
    { isProxy: boolean; implementation?: string; admin?: string; beacon?: string }
  >;

  constructor(rpc?: RpcProvider) {
    this.rpc = rpc || new RpcProvider();
    this.proxyCache = new Map();
  }

  /** Full inspection of an address. */
  async inspect(address: string, chain: string): Promise<AddressInfo> {
    const normalizedAddr = address.toLowerCase();

    // Fetch balance, nonce, and code in parallel
    const [balanceWei, nonce, code] = await Promise.all([
      this.rpc.getBalance(chain, normalizedAddr),
      this.rpc.getTransactionCount(chain, normalizedAddr),
      this.rpc.getCode(chain, normalizedAddr),
    ]);

    const isContractAddress = code !== '0x' && code !== '0x0' && code.length > 2;
    const codeSize = isContractAddress ? (code.length - 2) / 2 : 0; // hex chars / 2 = bytes

    const info: AddressInfo = {
      address: normalizedAddr,
      chain,
      type: isContractAddress ? 'contract' : 'eoa',
      balance: this.rpc.formatValue(balanceWei, chain),
      balanceWei: balanceWei.toString(),
      nonce,
      transactionCount: nonce,
    };

    if (isContractAddress) {
      info.code = code;
      info.codeSize = codeSize;

      // Detect proxy pattern
      const proxyInfo = await this.detectProxy(normalizedAddr, chain);
      info.isProxy = proxyInfo.isProxy;
      if (proxyInfo.implementation) {
        info.implementationAddress = proxyInfo.implementation;
      }

      // Read first 5 storage slots for a quick overview
      try {
        info.storageSlots = await this.readStorageRange(normalizedAddr, chain, 0, 5);
      } catch {
        // Non-critical — some RPCs may not support eth_getStorageAt
      }
    }

    return info;
  }

  /** Check if an address has deployed code (is a contract). */
  async isContract(address: string, chain: string): Promise<boolean> {
    const code = await this.rpc.getCode(chain, address.toLowerCase());
    return code !== '0x' && code !== '0x0' && code.length > 2;
  }

  /**
   * Detect EIP-1967 proxy and find the implementation address.
   *
   * Checks the three standard EIP-1967 storage slots. If the implementation
   * slot contains a non-zero address, the contract is considered a proxy.
   */
  async detectProxy(
    address: string,
    chain: string
  ): Promise<{ isProxy: boolean; implementation?: string; admin?: string; beacon?: string }> {
    const normalizedAddr = address.toLowerCase();
    const cacheKey = `${chain}:${normalizedAddr}`;
    const cached = this.proxyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Read all three EIP-1967 slots in parallel
    let implSlot: string;
    let adminSlot: string;
    let beaconSlot: string;

    try {
      [implSlot, adminSlot, beaconSlot] = await Promise.all([
        this.rpc.getStorageAt(chain, normalizedAddr, EIP1967_SLOTS.implementation),
        this.rpc.getStorageAt(chain, normalizedAddr, EIP1967_SLOTS.admin),
        this.rpc.getStorageAt(chain, normalizedAddr, EIP1967_SLOTS.beacon),
      ]);
    } catch {
      return { isProxy: false };
    }

    const implAddress = this.extractAddress(implSlot);
    const adminAddress = this.extractAddress(adminSlot);
    const beaconAddress = this.extractAddress(beaconSlot);

    const isProxy = implAddress !== null || beaconAddress !== null;

    const result = {
      isProxy,
      implementation: implAddress || undefined,
      admin: adminAddress || undefined,
      beacon: beaconAddress || undefined,
    };
    this.proxyCache.set(cacheKey, result);
    return result;
  }

  /** Read a single storage slot. */
  async readStorage(address: string, chain: string, slot: string): Promise<string> {
    return await this.rpc.getStorageAt(chain, address.toLowerCase(), slot);
  }

  /** Read a range of sequential storage slots. */
  async readStorageRange(
    address: string,
    chain: string,
    startSlot: number,
    count: number
  ): Promise<Array<{ slot: string; value: string }>> {
    const normalizedAddr = address.toLowerCase();
    const results: Array<{ slot: string; value: string }> = [];

    // Fetch all slots in parallel
    const slotHexes = Array.from({ length: count }, (_, i) => '0x' + (startSlot + i).toString(16));

    const values = await Promise.all(
      slotHexes.map((slotHex) => this.rpc.getStorageAt(chain, normalizedAddr, slotHex))
    );

    for (let i = 0; i < count; i++) {
      results.push({
        slot: slotHexes[i],
        value: values[i],
      });
    }

    return results;
  }

  /** Generate a markdown report for an address inspection. */
  generateReport(info: AddressInfo): string {
    const lines: string[] = [];

    const chainConfig = this.rpc.getChain(info.chain);
    const chainName = chainConfig?.name || info.chain;
    const explorerUrl = chainConfig?.explorerUrl;

    lines.push('# Address Inspection');
    lines.push('');

    const addressLink = explorerUrl
      ? `[\`${info.address}\`](${explorerUrl}/address/${info.address})`
      : `\`${info.address}\``;
    lines.push(`**Address:** ${addressLink}`);
    lines.push(`**Chain:** ${chainName}`);
    lines.push(
      `**Type:** ${info.type === 'contract' ? 'Contract' : 'Externally Owned Account (EOA)'}`
    );
    lines.push('');

    // Balance
    lines.push('## Balance');
    lines.push('');
    lines.push(`- **Balance:** ${info.balance}`);
    lines.push(`- **Balance (wei):** ${info.balanceWei}`);
    lines.push(`- **Nonce / Tx Count:** ${info.nonce}`);
    lines.push('');

    // Contract details
    if (info.type === 'contract') {
      lines.push('## Contract Details');
      lines.push('');
      lines.push(`- **Code Size:** ${info.codeSize?.toLocaleString()} bytes`);

      if (info.codeSize && info.codeSize > 0) {
        const sizeKB = (info.codeSize / 1024).toFixed(2);
        const eip170Percent = ((info.codeSize / 24576) * 100).toFixed(1);
        lines.push(`- **Code Size (KB):** ${sizeKB} KB (${eip170Percent}% of EIP-170 limit)`);
      }

      // Proxy info
      if (info.isProxy) {
        lines.push('');
        lines.push('### Proxy Detected (EIP-1967)');
        lines.push('');
        if (info.implementationAddress) {
          const implLink = explorerUrl
            ? `[\`${info.implementationAddress}\`](${explorerUrl}/address/${info.implementationAddress})`
            : `\`${info.implementationAddress}\``;
          lines.push(`- **Implementation:** ${implLink}`);
        }
      }

      // Storage slots
      if (info.storageSlots && info.storageSlots.length > 0) {
        const hasNonZero = info.storageSlots.some((s) => s.value !== '0x' + '0'.repeat(64));

        if (hasNonZero) {
          lines.push('');
          lines.push('### Storage Slots (first 5)');
          lines.push('');
          lines.push('| Slot | Value |');
          lines.push('|------|-------|');
          for (const slot of info.storageSlots) {
            const isZero = slot.value === '0x' + '0'.repeat(64);
            const display = isZero ? '(empty)' : `\`${slot.value}\``;
            lines.push(`| ${slot.slot} | ${display} |`);
          }
        }
      }

      // Raw bytecode preview
      if (info.code && info.code.length > 2) {
        lines.push('');
        lines.push('### Bytecode Preview');
        lines.push('');
        const preview =
          info.code.length > 200
            ? info.code.substring(0, 200) + `... (${info.code.length - 2} hex chars total)`
            : info.code;
        lines.push(`\`\`\`\n${preview}\n\`\`\``);
      }
    }

    lines.push('');

    return lines.join('\n');
  }

  // ---- Private Helpers ----

  /**
   * Extract an address from a 32-byte storage value.
   *
   * Returns null if the value is zero or invalid.
   */
  private extractAddress(slotValue: string): string | null {
    if (!slotValue || slotValue === '0x' || slotValue === '0x0') {
      return null;
    }

    const raw = slotValue.startsWith('0x') ? slotValue.substring(2) : slotValue;
    const padded = raw.padStart(64, '0');

    // Address is in the last 20 bytes (40 hex chars)
    const addrHex = padded.substring(24);
    const addr = '0x' + addrHex;

    // Check for zero address
    if (addr === ZERO_ADDRESS) {
      return null;
    }

    return addr;
  }
}
