/**
 * Upgradeable Contract Storage Layout Comparison
 *
 * Compares storage layouts between two versions of an upgradeable contract
 * to detect breaking changes. Storage layout compatibility is critical for
 * proxy-based upgrade patterns (UUPS, Transparent Proxy, Beacon) where the
 * proxy's storage slots must remain consistent across implementations.
 */

import { UpgradeReport, StorageSlotDiff } from '../types';

/**
 * Represents a single state variable extracted from Solidity source.
 */
interface StateVariable {
  name: string;
  type: string;
  line: number;
  sizeBytes: number;
}

// Pre-compiled regex patterns — hoisted to module scope to avoid re-compilation per call
const RE_STRIP_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_STRIP_LINE_COMMENT = /\/\/.*/g;
const RE_NON_NEWLINE = /[^\n]/g;
const RE_STATE_VAR_DECL =
  /^\s*(mapping\s*\([^)]+\)|address|uint\d*|int\d*|bool|bytes\d*|string|bytes)\s+(?:public|private|internal)?\s*(\w+)/gm;
const RE_CONSTANT_OR_IMMUTABLE = /\b(constant|immutable)\b/;
const RE_STORAGE_GAP = /uint256\[\d+\]\s+(?:private\s+)?__gap/;
const RE_STORAGE_GAP_SIZE = /uint256\[(\d+)\]\s+(?:private\s+)?__gap/;
const RE_BYTES_N = /^bytes(\d+)$/;

export class UpgradeAnalyzer {
  /**
   * Size in bytes for known Solidity value types.
   * Mappings, dynamic arrays, strings, and bytes use a full 32-byte slot
   * for their base storage pointer.
   */
  private static readonly TYPE_SIZES: Record<string, number> = {
    bool: 1,
    uint8: 1,
    int8: 1,
    uint16: 2,
    int16: 2,
    uint24: 3,
    int24: 3,
    uint32: 4,
    int32: 4,
    uint40: 5,
    int40: 5,
    uint48: 6,
    int48: 6,
    uint56: 7,
    int56: 7,
    uint64: 8,
    int64: 8,
    uint72: 9,
    int72: 9,
    uint80: 10,
    int80: 10,
    uint88: 11,
    int88: 11,
    uint96: 12,
    int96: 12,
    uint104: 13,
    int104: 13,
    uint112: 14,
    int112: 14,
    uint120: 15,
    int120: 15,
    uint128: 16,
    int128: 16,
    uint136: 17,
    int136: 17,
    uint144: 18,
    int144: 18,
    uint152: 19,
    int152: 19,
    uint160: 20,
    int160: 20,
    uint168: 21,
    int168: 21,
    uint176: 22,
    int176: 22,
    uint184: 23,
    int184: 23,
    uint192: 24,
    int192: 24,
    uint200: 25,
    int200: 25,
    uint208: 26,
    int208: 26,
    uint216: 27,
    int216: 27,
    uint224: 28,
    int224: 28,
    uint232: 29,
    int232: 29,
    uint240: 30,
    int240: 30,
    uint248: 31,
    int248: 31,
    uint256: 32,
    int256: 32,
    address: 20,
    bytes1: 1,
    bytes2: 2,
    bytes3: 3,
    bytes4: 4,
    bytes5: 5,
    bytes6: 6,
    bytes7: 7,
    bytes8: 8,
    bytes9: 9,
    bytes10: 10,
    bytes11: 11,
    bytes12: 12,
    bytes13: 13,
    bytes14: 14,
    bytes15: 15,
    bytes16: 16,
    bytes17: 17,
    bytes18: 18,
    bytes19: 19,
    bytes20: 20,
    bytes21: 21,
    bytes22: 22,
    bytes23: 23,
    bytes24: 24,
    bytes25: 25,
    bytes26: 26,
    bytes27: 27,
    bytes28: 28,
    bytes29: 29,
    bytes30: 30,
    bytes31: 31,
    bytes32: 32,
  };

  /**
   * Analyze storage layout compatibility between two contract versions.
   *
   * Extracts state variables from both sources using regex, assigns them to
   * storage slots following Solidity's layout rules, and compares the two
   * layouts to detect breaking changes.
   *
   * @param oldSource - Solidity source code of the original implementation
   * @param newSource - Solidity source code of the upgraded implementation
   * @param contractName - Contract name for the report
   * @returns Upgrade compatibility report with diffs and warnings
   */
  public analyzeUpgrade(oldSource: string, newSource: string, contractName: string): UpgradeReport {
    const oldVars = this.extractStateVariables(oldSource);
    const newVars = this.extractStateVariables(newSource);

    const diffs: StorageSlotDiff[] = [];
    const warnings: string[] = [];

    // Assign slot positions to old and new variables
    const oldSlots = this.assignSlots(oldVars);
    const newSlots = this.assignSlots(newVars);

    // Compare slot by slot
    const maxSlot = Math.max(
      oldSlots.length > 0 ? oldSlots[oldSlots.length - 1].slot + 1 : 0,
      newSlots.length > 0 ? newSlots[newSlots.length - 1].slot + 1 : 0
    );

    // Build slot -> variable maps for comparison
    const oldSlotMap = new Map<number, { name: string; type: string }>();
    for (const sv of oldSlots) {
      // For packed variables, use the base slot
      if (!oldSlotMap.has(sv.slot)) {
        oldSlotMap.set(sv.slot, { name: sv.name, type: sv.type });
      }
    }

    const newSlotMap = new Map<number, { name: string; type: string }>();
    for (const sv of newSlots) {
      if (!newSlotMap.has(sv.slot)) {
        newSlotMap.set(sv.slot, { name: sv.name, type: sv.type });
      }
    }

    // Check each slot for changes
    for (let slot = 0; slot < maxSlot; slot++) {
      const oldVar = oldSlotMap.get(slot);
      const newVar = newSlotMap.get(slot);

      if (oldVar && !newVar) {
        // Variable was removed
        diffs.push({
          slot,
          oldVar: oldVar.name,
          oldType: oldVar.type,
          issue: 'removed',
        });
        warnings.push(
          `Slot ${slot}: Variable \`${oldVar.name}\` (${oldVar.type}) was removed. ` +
            'Removing variables from the middle of storage shifts subsequent slots.'
        );
      } else if (oldVar && newVar && oldVar.name !== newVar.name) {
        // Check if it's a reorder or insertion
        const oldVarIndex = oldVars.findIndex((v) => v.name === oldVar.name);
        const newVarIndex = newVars.findIndex((v) => v.name === newVar.name);

        if (newVarIndex === -1) {
          // Old variable no longer exists at this slot, new one was inserted
          diffs.push({
            slot,
            oldVar: oldVar.name,
            newVar: newVar.name,
            oldType: oldVar.type,
            newType: newVar.type,
            issue: 'inserted_before_existing',
          });
          warnings.push(
            `Slot ${slot}: Variable \`${newVar.name}\` was inserted before existing variable \`${oldVar.name}\`. ` +
              'This shifts all subsequent storage slots and corrupts data.'
          );
        } else if (oldVarIndex !== -1) {
          // Both exist but at different positions -- reorder
          diffs.push({
            slot,
            oldVar: oldVar.name,
            newVar: newVar.name,
            oldType: oldVar.type,
            newType: newVar.type,
            issue: 'reordered',
          });
          warnings.push(
            `Slot ${slot}: Variable order changed from \`${oldVar.name}\` to \`${newVar.name}\`. ` +
              'Reordering state variables changes their storage slots.'
          );
        }
      } else if (oldVar && newVar && oldVar.name === newVar.name && oldVar.type !== newVar.type) {
        // Same variable name, different type
        diffs.push({
          slot,
          oldVar: oldVar.name,
          newVar: newVar.name,
          oldType: oldVar.type,
          newType: newVar.type,
          issue: 'type_changed',
        });
        warnings.push(
          `Slot ${slot}: Variable \`${oldVar.name}\` type changed from \`${oldVar.type}\` to \`${newVar.type}\`. ` +
            'Type changes can corrupt stored data if the encoding differs.'
        );
      }
    }

    // Additional checks

    // Check if new variables were appended (safe operation)
    if (newVars.length > oldVars.length && diffs.length === 0) {
      const appendedCount = newVars.length - oldVars.length;
      warnings.push(
        `${appendedCount} new variable(s) appended at the end of storage. This is safe for upgrades.`
      );
    }

    // Check for storage gaps
    const oldHasGap = RE_STORAGE_GAP.test(oldSource);
    const newHasGap = RE_STORAGE_GAP.test(newSource);

    if (oldHasGap && !newHasGap) {
      warnings.push(
        'Storage gap `__gap` was removed in the new version. ' +
          'This may break derived contracts that depend on consistent storage layout.'
      );
    }

    if (oldHasGap && newHasGap) {
      // Check if gap size was reduced appropriately for new variables
      const oldGapMatch = oldSource.match(RE_STORAGE_GAP_SIZE);
      const newGapMatch = newSource.match(RE_STORAGE_GAP_SIZE);

      if (oldGapMatch && newGapMatch) {
        const oldGapSize = parseInt(oldGapMatch[1], 10);
        const newGapSize = parseInt(newGapMatch[1], 10);
        const newVarCount = newVars.length - oldVars.length;

        if (newGapSize >= oldGapSize && newVarCount > 0) {
          warnings.push(
            `Storage gap was not reduced to accommodate ${newVarCount} new variable(s). ` +
              `Expected gap size ~${oldGapSize - newVarCount}, got ${newGapSize}.`
          );
        }
      }
    }

    const compatible = diffs.length === 0;

    return {
      contractName,
      compatible,
      diffs,
      warnings,
    };
  }

  /**
   * Extract state variable declarations from Solidity source using regex.
   *
   * Skips variables marked as `constant` or `immutable` since they do not
   * occupy storage slots.
   *
   * @param source - Raw Solidity source code
   * @returns Ordered array of state variable descriptors
   */
  private extractStateVariables(source: string): StateVariable[] {
    const variables: StateVariable[] = [];

    // Strip comments to avoid false positives
    const cleanSource = source
      .replace(RE_STRIP_BLOCK_COMMENT, (match) => match.replace(RE_NON_NEWLINE, ' '))
      .replace(RE_STRIP_LINE_COMMENT, '');

    // Match state variable declarations
    RE_STATE_VAR_DECL.lastIndex = 0;

    let match;
    while ((match = RE_STATE_VAR_DECL.exec(cleanSource)) !== null) {
      const fullLine = cleanSource.substring(
        cleanSource.lastIndexOf('\n', match.index) + 1,
        cleanSource.indexOf('\n', match.index)
      );

      // Skip constants and immutables
      if (RE_CONSTANT_OR_IMMUTABLE.test(fullLine)) {
        continue;
      }

      // Skip function-local variables (inside function bodies)
      if (this.isInsideFunction(cleanSource, match.index)) {
        continue;
      }

      const type = match[1].replace(/\s+/g, ' ').trim();
      const name = match[2];
      const line = cleanSource.substring(0, match.index).split('\n').length;
      const sizeBytes = this.getTypeSize(type);

      variables.push({ name, type, line, sizeBytes });
    }

    return variables;
  }

  /**
   * Determine if a position in the source is inside a function body.
   * Uses brace counting to decide whether we're at contract-level or function-level.
   */
  private isInsideFunction(source: string, position: number): boolean {
    const before = source.substring(0, position);

    // Count brace depth. At contract level, depth is 1 (inside contract {}).
    // Inside a function, depth is >= 2.
    let depth = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === '{') {
        depth++;
      } else if (before[i] === '}') {
        depth--;
      }
    }

    // Depth > 1 means we're inside a function/modifier/constructor body
    return depth > 1;
  }

  /**
   * Assign EVM storage slot numbers to state variables following Solidity's layout rules.
   *
   * Variables are packed into 32-byte slots when possible. Mappings, dynamic
   * arrays, strings, and bytes always start a new slot and occupy the full slot.
   */
  private assignSlots(
    variables: StateVariable[]
  ): Array<StateVariable & { slot: number; offset: number }> {
    const result: Array<StateVariable & { slot: number; offset: number }> = [];
    let currentSlot = 0;
    let currentOffset = 0;

    for (const variable of variables) {
      const size = variable.sizeBytes;

      // Mappings, dynamic arrays, string, and bytes always start a new slot
      if (
        variable.type.startsWith('mapping') ||
        variable.type.includes('[]') ||
        variable.type === 'string' ||
        variable.type === 'bytes'
      ) {
        if (currentOffset > 0) {
          currentSlot++;
          currentOffset = 0;
        }
        result.push({ ...variable, slot: currentSlot, offset: 0 });
        currentSlot++;
        currentOffset = 0;
        continue;
      }

      // If variable doesn't fit in remaining space, start a new slot
      if (currentOffset + size > 32) {
        currentSlot++;
        currentOffset = 0;
      }

      result.push({ ...variable, slot: currentSlot, offset: currentOffset });
      currentOffset += size;

      if (currentOffset >= 32) {
        currentSlot++;
        currentOffset = 0;
      }
    }

    return result;
  }

  /**
   * Get the byte size of a Solidity type.
   *
   * @param type - Solidity type string
   * @returns Size in bytes (32 for reference types)
   */
  private getTypeSize(type: string): number {
    // Normalize: remove spaces
    const normalized = type.replace(/\s+/g, '');

    // Mappings, dynamic arrays, string, bytes -> full slot
    if (
      normalized.startsWith('mapping') ||
      normalized.includes('[]') ||
      normalized === 'string' ||
      normalized === 'bytes'
    ) {
      return 32;
    }

    // Handle uint/int without explicit size (uint = uint256, int = int256)
    if (normalized === 'uint') {
      return 32;
    }
    if (normalized === 'int') {
      return 32;
    }

    // Look up in the size table
    if (UpgradeAnalyzer.TYPE_SIZES[normalized] !== undefined) {
      return UpgradeAnalyzer.TYPE_SIZES[normalized];
    }

    // Handle bytesN where N is 1-32
    const bytesMatch = normalized.match(RE_BYTES_N);
    if (bytesMatch) {
      const n = parseInt(bytesMatch[1], 10);
      if (n >= 1 && n <= 32) {
        return n;
      }
    }

    // Unknown type (struct, enum, custom) -- assume full slot
    return 32;
  }

  /**
   * Generate a human-readable upgrade analysis report.
   *
   * @param report - The upgrade analysis report
   * @returns Markdown-formatted report string
   */
  public generateReport(report: UpgradeReport): string {
    let output = `# Upgrade Analysis: ${report.contractName}\n\n`;

    const status = report.compatible
      ? '[COMPATIBLE] Storage layout is upgrade-safe.'
      : '[INCOMPATIBLE] Breaking storage layout changes detected!';

    output += `**Status:** ${status}\n\n`;

    if (report.diffs.length > 0) {
      output += '## Storage Slot Differences\n\n';
      output += '| Slot | Old Variable | Old Type | New Variable | New Type | Issue |\n';
      output += '|------|-------------|----------|-------------|----------|-------|\n';

      for (const diff of report.diffs) {
        output += `| ${diff.slot} `;
        output += `| ${diff.oldVar || '-'} `;
        output += `| ${diff.oldType || '-'} `;
        output += `| ${diff.newVar || '-'} `;
        output += `| ${diff.newType || '-'} `;
        output += `| ${diff.issue.replace(/_/g, ' ')} |\n`;
      }

      output += '\n';
    }

    if (report.warnings.length > 0) {
      output += '## Warnings\n\n';
      for (const warning of report.warnings) {
        output += `- ${warning}\n`;
      }
      output += '\n';
    }

    if (report.compatible && report.diffs.length === 0) {
      output += 'No breaking storage changes detected. The upgrade is safe to proceed.\n';
    }

    return output;
  }
}
