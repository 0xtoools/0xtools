/**
 * Storage Layout Analyzer - Lightweight storage slot analysis
 * Shows developers exactly what they're paying for in storage costs
 */

import * as vscode from 'vscode';

export interface StorageSlot {
  slot: number;
  offset: number; // Byte offset within slot (0-31)
  size: number; // Size in bytes
  variable: string;
  type: string;
  packed: boolean; // Is this variable packed with others?
  wastedBytes?: number; // Wasted space in this slot
}

export interface StorageLayout {
  totalSlots: number;
  variables: StorageSlot[];
  packingOpportunities: PackingOpportunity[];
  estimatedCost: {
    coldReads: number; // Unique slots × 2100 gas
    coldWrites: number; // Unique slots × 20000 gas
    warmReads: number; // 100 gas per read
    warmWrites: number; // 100 gas per write
  };
  collisionWarnings: string[];
}

export interface PackingOpportunity {
  variables: string[];
  currentSlots: number;
  optimizedSlots: number;
  potentialSavings: number; // Gas saved per transaction
  suggestion: string;
}

// Pre-compiled regex patterns — hoisted to module scope to avoid re-compilation per call
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_LINE_COMMENT = /\/\/.*/g;
const RE_DOUBLE_QUOTED = /"[^"]*"/g;
const RE_SINGLE_QUOTED = /'[^']*'/g;
const RE_STATE_VAR =
  /(?:public|private|internal)?\s+(address|uint\d*|int\d*|bool|bytes\d*|string|mapping\([^)]+\)|\w+)\s+(?:public|private|internal)?\s*(\w+)\s*(?:=|;)/g;
const RE_STORAGE_GAP = /uint256\[\d+\]\s+private\s+__gap/i;

export class StorageLayoutAnalyzer {
  private readonly SLOT_SIZE = 32; // 32 bytes per slot
  private readonly COLD_SLOAD = 2100;
  private readonly COLD_SSTORE = 20000;
  private readonly WARM_SLOAD = 100;
  private readonly WARM_SSTORE = 100;

  // Solidity type sizes in bytes
  private readonly TYPE_SIZES: { [key: string]: number } = {
    bool: 1,
    uint8: 1,
    int8: 1,
    uint16: 2,
    int16: 2,
    uint32: 4,
    int32: 4,
    uint64: 8,
    int64: 8,
    uint128: 16,
    int128: 16,
    uint256: 32,
    int256: 32,
    address: 20,
    bytes1: 1,
    bytes2: 2,
    bytes4: 4,
    bytes8: 8,
    bytes16: 16,
    bytes32: 32,
  };

  /**
   * Analyze storage layout from contract code (lightweight - no compilation)
   */
  public analyzeContract(contractCode: string, contractName: string): StorageLayout {
    const variables = this.extractStateVariables(contractCode);
    const slots = this.calculateSlots(variables);
    const packingOps = this.findPackingOpportunities(slots);
    const cost = this.estimateCosts(slots);
    const warnings = this.detectCollisions(contractCode, slots);

    return {
      totalSlots: slots.length > 0 ? Math.max(...slots.map((s) => s.slot)) + 1 : 0,
      variables: slots,
      packingOpportunities: packingOps,
      estimatedCost: cost,
      collisionWarnings: warnings,
    };
  }

  /**
   * Extract state variables from contract (regex-based, lightweight)
   */
  private extractStateVariables(code: string): Array<{ name: string; type: string; line: number }> {
    const variables: Array<{ name: string; type: string; line: number }> = [];

    // Remove comments and strings
    const cleanCode = code
      .replace(RE_BLOCK_COMMENT, '')
      .replace(RE_LINE_COMMENT, '')
      .replace(RE_DOUBLE_QUOTED, '""')
      .replace(RE_SINGLE_QUOTED, "''");

    // Match state variable declarations
    RE_STATE_VAR.lastIndex = 0;

    let match;
    while ((match = RE_STATE_VAR.exec(cleanCode)) !== null) {
      const [, type, name] = match;

      // Skip constants and immutables (they don't use storage)
      const beforeMatch = cleanCode.substring(Math.max(0, match.index - 100), match.index);
      if (beforeMatch.includes('constant') || beforeMatch.includes('immutable')) {
        continue;
      }

      // Calculate line number
      const lineNumber = cleanCode.substring(0, match.index).split('\n').length;

      variables.push({ name, type: type.trim(), line: lineNumber });
    }

    return variables;
  }

  /**
   * Calculate storage slots for variables
   */
  private calculateSlots(
    variables: Array<{ name: string; type: string; line: number }>
  ): StorageSlot[] {
    const slots: StorageSlot[] = [];
    let currentSlot = 0;
    let currentOffset = 0;

    for (const variable of variables) {
      const size = this.getTypeSize(variable.type);

      // Mappings and dynamic arrays always start a new slot
      if (variable.type.startsWith('mapping') || variable.type.includes('[]')) {
        if (currentOffset > 0) {
          currentSlot++;
          currentOffset = 0;
        }
        slots.push({
          slot: currentSlot,
          offset: 0,
          size: 32,
          variable: variable.name,
          type: variable.type,
          packed: false,
          wastedBytes: 0,
        });
        currentSlot++;
        currentOffset = 0;
        continue;
      }

      // If variable doesn't fit in current slot, move to next
      if (currentOffset + size > this.SLOT_SIZE) {
        const wastedBytes = this.SLOT_SIZE - currentOffset;
        if (slots.length > 0) {
          slots[slots.length - 1].wastedBytes = wastedBytes;
        }
        currentSlot++;
        currentOffset = 0;
      }

      const packed = currentOffset > 0;
      slots.push({
        slot: currentSlot,
        offset: currentOffset,
        size,
        variable: variable.name,
        type: variable.type,
        packed,
        wastedBytes: 0,
      });

      currentOffset += size;

      // If we've filled the slot, move to next
      if (currentOffset >= this.SLOT_SIZE) {
        currentSlot++;
        currentOffset = 0;
      }
    }

    // Mark wasted bytes in last slot
    if (currentOffset > 0 && currentOffset < this.SLOT_SIZE && slots.length > 0) {
      slots[slots.length - 1].wastedBytes = this.SLOT_SIZE - currentOffset;
    }

    return slots;
  }

  /**
   * Get type size in bytes
   */
  private getTypeSize(type: string): number {
    // Handle arrays and mappings
    if (type.includes('[]') || type.startsWith('mapping')) {
      return 32; // Reference types take full slot
    }

    // Handle structs (assume full slot for now)
    if (!this.TYPE_SIZES[type]) {
      return 32;
    }

    return this.TYPE_SIZES[type];
  }

  /**
   * Find packing opportunities to save gas
   */
  private findPackingOpportunities(slots: StorageSlot[]): PackingOpportunity[] {
    const opportunities: PackingOpportunity[] = [];

    // Group by slot
    const slotGroups = new Map<number, StorageSlot[]>();
    for (const slot of slots) {
      if (!slotGroups.has(slot.slot)) {
        slotGroups.set(slot.slot, []);
      }
      slotGroups.get(slot.slot)!.push(slot);
    }

    // Look for slots with wasted space that could be packed
    slotGroups.forEach((vars, slotNum) => {
      const totalUsed = vars.reduce((sum, v) => sum + v.size, 0);
      const wastedBytes = this.SLOT_SIZE - totalUsed;

      if (wastedBytes >= 8 && vars.length === 1) {
        // Single variable with significant wasted space
        const variable = vars[0];
        opportunities.push({
          variables: [variable.variable],
          currentSlots: 1,
          optimizedSlots: 1,
          potentialSavings: this.COLD_SSTORE + this.COLD_SLOAD, // Could pack another var here
          suggestion: `Slot ${slotNum} has ${wastedBytes} bytes wasted. Consider packing with uint${wastedBytes * 8} or smaller variables.`,
        });
      }
    });

    // Look for consecutive full slots of small types that could be packed
    const smallTypeSlots: number[] = [];
    slotGroups.forEach((vars, slotNum) => {
      if (vars.length === 1 && vars[0].size < 32) {
        smallTypeSlots.push(slotNum);
      }
    });

    if (smallTypeSlots.length >= 2) {
      const consecutiveGroups = this.findConsecutiveGroups(smallTypeSlots);
      for (const group of consecutiveGroups) {
        if (group.length >= 2) {
          const variables = group.map((s) => slotGroups.get(s)![0].variable);
          const totalSize = group.reduce((sum, s) => sum + slotGroups.get(s)![0].size, 0);
          const optimizedSlots = Math.ceil(totalSize / this.SLOT_SIZE);
          const savedSlots = group.length - optimizedSlots;

          if (savedSlots > 0) {
            opportunities.push({
              variables,
              currentSlots: group.length,
              optimizedSlots,
              potentialSavings: savedSlots * (this.COLD_SSTORE + this.COLD_SLOAD),
              suggestion: `Pack ${variables.join(', ')} together to save ${savedSlots} storage slot${savedSlots > 1 ? 's' : ''} (~${savedSlots * 22100} gas per transaction).`,
            });
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * Find consecutive groups in array
   */
  private findConsecutiveGroups(nums: number[]): number[][] {
    if (nums.length === 0) {
      return [];
    }

    const sorted = [...nums].sort((a, b) => a - b);
    const groups: number[][] = [];
    let currentGroup: number[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) {
        currentGroup.push(sorted[i]);
      } else {
        if (currentGroup.length >= 2) {
          groups.push(currentGroup);
        }
        currentGroup = [sorted[i]];
      }
    }

    if (currentGroup.length >= 2) {
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * Estimate storage costs
   */
  private estimateCosts(slots: StorageSlot[]): {
    coldReads: number;
    coldWrites: number;
    warmReads: number;
    warmWrites: number;
  } {
    const uniqueSlots = new Set(slots.map((s) => s.slot)).size;

    return {
      coldReads: uniqueSlots * this.COLD_SLOAD,
      coldWrites: uniqueSlots * this.COLD_SSTORE,
      warmReads: uniqueSlots * this.WARM_SLOAD,
      warmWrites: uniqueSlots * this.WARM_SSTORE,
    };
  }

  /**
   * Detect potential storage collisions (for upgradeable contracts)
   */
  private detectCollisions(code: string, slots: StorageSlot[]): string[] {
    const warnings: string[] = [];

    // Check for upgradeable patterns
    const isUpgradeable =
      code.includes('Initializable') ||
      code.includes('UUPSUpgradeable') ||
      code.includes('TransparentUpgradeableProxy');

    if (isUpgradeable) {
      warnings.push(
        '⚠️ Upgradeable contract detected. Ensure storage layout compatibility between versions.'
      );

      // Check for storage gaps
      const hasGap = RE_STORAGE_GAP.test(code);
      if (!hasGap) {
        warnings.push('Consider adding storage gap: uint256[50] private __gap;');
      }
    }

    return warnings;
  }

  /**
   * Generate markdown report
   */
  public generateReport(layout: StorageLayout, contractName: string): string {
    let report = `# 📊 Storage Layout Analysis: ${contractName}\n\n`;

    report += `**Total Storage Slots Used**: ${layout.totalSlots}\n\n`;

    // Cost summary
    report += `## 💰 Estimated Gas Costs\n\n`;
    report += `| Operation | Cost (gas) |\n`;
    report += `|-----------|------------|\n`;
    report += `| Cold Reads (SLOAD) | ${layout.estimatedCost.coldReads.toLocaleString()} |\n`;
    report += `| Cold Writes (SSTORE) | ${layout.estimatedCost.coldWrites.toLocaleString()} |\n`;
    report += `| Warm Reads | ${layout.estimatedCost.warmReads.toLocaleString()} |\n`;
    report += `| Warm Writes | ${layout.estimatedCost.warmWrites.toLocaleString()} |\n\n`;

    // Slot layout
    report += `## 🗄️ Storage Slot Layout\n\n`;
    report += `| Slot | Offset | Size | Variable | Type | Status |\n`;
    report += `|------|--------|------|----------|------|--------|\n`;

    layout.variables.forEach((slot) => {
      const status = slot.packed
        ? '✅ Packed'
        : slot.wastedBytes && slot.wastedBytes > 0
          ? '⚠️ Wasted'
          : '✓';
      const wastedInfo = slot.wastedBytes ? ` (${slot.wastedBytes}B wasted)` : '';
      report += `| ${slot.slot} | ${slot.offset} | ${slot.size}B | ${slot.variable} | ${slot.type} | ${status}${wastedInfo} |\n`;
    });

    // Packing opportunities
    if (layout.packingOpportunities.length > 0) {
      report += `\n## 🎯 Optimization Opportunities\n\n`;
      layout.packingOpportunities.forEach((opp, i) => {
        report += `### ${i + 1}. ${opp.suggestion}\n`;
        report += `- Variables: \`${opp.variables.join('`, `')}\`\n`;
        report += `- Current: ${opp.currentSlots} slot${opp.currentSlots > 1 ? 's' : ''}\n`;
        report += `- Optimized: ${opp.optimizedSlots} slot${opp.optimizedSlots > 1 ? 's' : ''}\n`;
        report += `- **Savings**: ~${opp.potentialSavings.toLocaleString()} gas per transaction\n\n`;
      });
    }

    // Collision warnings
    if (layout.collisionWarnings.length > 0) {
      report += `## ⚠️ Warnings\n\n`;
      layout.collisionWarnings.forEach((warning) => {
        report += `- ${warning}\n`;
      });
      report += '\n';
    }

    return report;
  }

  /**
   * Create inline decorations for storage annotations
   */
  public createStorageDecorations(
    layout: StorageLayout,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    layout.variables.forEach((slot) => {
      // Find variable declaration
      const pattern = new RegExp(
        `\\b(address|uint\\d*|int\\d*|bool|bytes\\d*|string|mapping\\([^)]+\\)|\\w+)\\s+(?:public|private|internal)?\\s*${slot.variable}\\s*[;=]`
      );
      const match = pattern.exec(content);

      if (match) {
        const position = document.positionAt(match.index + match[0].length - 1);
        const wastedInfo =
          slot.wastedBytes && slot.wastedBytes > 0 ? `, ${slot.wastedBytes}B wasted` : '';
        const packedInfo = slot.packed ? ' (packed)' : '';

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` 🗄️ Slot ${slot.slot}:${slot.offset} (${slot.size}B${wastedInfo})${packedInfo}`,
              color: slot.packed ? '#4ade80' : slot.wastedBytes ? '#fb923c' : '#94a3b8',
              fontStyle: 'italic',
              margin: '0 0 0 1em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**Storage Slot ${slot.slot}**\n\n` +
              `- Offset: ${slot.offset} bytes\n` +
              `- Size: ${slot.size} bytes\n` +
              `- Cold SLOAD: ${this.COLD_SLOAD} gas\n` +
              `- Cold SSTORE: ${this.COLD_SSTORE} gas\n` +
              (slot.packed ? '\n✅ **Packed** with other variables (gas efficient)' : '') +
              (slot.wastedBytes && slot.wastedBytes > 0
                ? `\n\n⚠️ **${slot.wastedBytes} bytes wasted** in this slot`
                : '')
          ),
        };

        decorations.push(decoration);
      }
    });

    return decorations;
  }
}
