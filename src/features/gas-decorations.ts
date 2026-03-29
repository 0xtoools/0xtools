/**
 * Gas Decorations Provider - Remix-style inline gas annotations
 *
 * Provides inline decorations showing:
 * - Gas cost (with gradient coloring)
 * - Infinite gas warnings
 * - AST-based warnings (external calls in loops, etc.)
 *
 * This module handles VS Code decoration lifecycle and debouncing.
 */

import * as vscode from 'vscode';
import { GasInfo } from './SolcManager';

/**
 * Decoration style configuration
 */
const DECORATION_STYLES = {
  // Gas colors - gradient from green (cheap) to red (expensive)
  lowGas: '#73E068', // Green - < 50k gas
  mediumGas: '#FFD454', // Yellow - 50k-150k gas
  highGas: '#FFA64D', // Orange - 150k-500k gas
  veryHighGas: '#FF5555', // Red - > 500k gas
  infiniteGas: '#FF55FF', // Magenta - infinite/unbounded

  // Warning colors
  warning: '#FFD700',

  // Font settings
  fontStyle: 'normal',
  fontWeight: 'bold',
  margin: '0 0 0 1.5em',
};

/**
 * Gas threshold levels for coloring
 */
const GAS_THRESHOLDS = {
  low: 50_000,
  medium: 150_000,
  high: 500_000,
};

/**
 * Get color for gas value
 */
function getGasColor(gas: number | 'infinite'): string {
  if (gas === 'infinite') {
    return DECORATION_STYLES.infiniteGas;
  }

  if (gas < GAS_THRESHOLDS.low) {
    return DECORATION_STYLES.lowGas;
  }
  if (gas < GAS_THRESHOLDS.medium) {
    return DECORATION_STYLES.mediumGas;
  }
  if (gas < GAS_THRESHOLDS.high) {
    return DECORATION_STYLES.highGas;
  }
  return DECORATION_STYLES.veryHighGas;
}

/**
 * Format gas value for display
 */
function formatGas(gas: number | 'infinite'): string {
  if (gas === 'infinite') {
    return '∞';
  }

  if (gas >= 1_000_000) {
    return `${(gas / 1_000_000).toFixed(2)}M`;
  }
  if (gas >= 1_000) {
    return `${(gas / 1_000).toFixed(1)}k`;
  }
  return gas.toString();
}

/**
 * Decoration type for gas annotations
 * Created dynamically per-color to support gradient
 */
const decorationTypeCache = new Map<string, vscode.TextEditorDecorationType>();
const MAX_DECORATION_TYPES = 10; // Safety cap — only ~5 colors expected

/**
 * Get or create decoration type for a specific color.
 * The cache is bounded by MAX_DECORATION_TYPES; oldest entries are
 * disposed and evicted if the cap is reached.
 */
function getDecorationType(color: string): vscode.TextEditorDecorationType {
  const cached = decorationTypeCache.get(color);
  if (cached) {
    return cached;
  }

  // Evict oldest if at cap (dispose the VS Code resource)
  if (decorationTypeCache.size >= MAX_DECORATION_TYPES) {
    const oldestKey = decorationTypeCache.keys().next().value as string;
    const oldestType = decorationTypeCache.get(oldestKey);
    if (oldestType) {
      oldestType.dispose();
    }
    decorationTypeCache.delete(oldestKey);
  }

  const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color,
      fontStyle: DECORATION_STYLES.fontStyle,
      fontWeight: DECORATION_STYLES.fontWeight,
      margin: DECORATION_STYLES.margin,
    },
  });

  decorationTypeCache.set(color, decorationType);
  return decorationType;
}

/**
 * Clear all decoration types (for cleanup)
 */
export function clearDecorationTypes(): void {
  for (const decorationType of decorationTypeCache.values()) {
    decorationType.dispose();
  }
  decorationTypeCache.clear();
}

/**
 * Create gas decorations from GasInfo array
 *
 * @param gasInfo - Array of gas information from compilation
 * @param document - VS Code text document
 * @returns Map of decoration type to decoration array
 */
export function createGasDecorations(
  gasInfo: GasInfo[],
  document: vscode.TextDocument
): Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]> {
  const decorations = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();

  for (const info of gasInfo) {
    // Skip internal/private functions if configured
    // (can add configuration check here later)

    // Get line (0-based for VS Code)
    const line = info.loc.line - 1;
    if (line < 0 || line >= document.lineCount) {
      continue;
    }

    // Get the line text to find end position
    const lineText = document.lineAt(line).text;
    const range = new vscode.Range(line, lineText.length, line, lineText.length);

    // Get color based on gas
    const color = getGasColor(info.gas);
    const decorationType = getDecorationType(color);

    // Format display text
    const gasText = formatGas(info.gas);
    const warningText = info.warnings.length > 0 ? ' ' + info.warnings.join(' ') : '';
    const contentText = `  ⛽ ${gasText} gas${warningText}`;

    // Create decoration option
    const decorationOption: vscode.DecorationOptions = {
      range,
      renderOptions: {
        after: {
          contentText,
          color,
        },
      },
      hoverMessage: createHoverMessage(info),
    };

    // Add to map
    if (!decorations.has(decorationType)) {
      decorations.set(decorationType, []);
    }
    const decorationList = decorations.get(decorationType);
    if (decorationList) {
      decorationList.push(decorationOption);
    }
  }

  return decorations;
}

/**
 * Create hover message for gas decoration
 */
function createHoverMessage(info: GasInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;

  // Header
  md.appendMarkdown(`### ⛽ Gas Analysis: \`${info.name}\`\n\n`);

  // Gas info
  if (info.gas === 'infinite') {
    md.appendMarkdown('**Estimated Gas:** ∞ (unbounded)\n\n');
    md.appendMarkdown('> ⚠️ This function has unbounded gas consumption.\n\n');
  } else {
    md.appendMarkdown(`**Estimated Gas:** ${info.gas.toLocaleString()}\n\n`);

    // Complexity classification
    let complexity: string;
    if (info.gas < GAS_THRESHOLDS.low) {
      complexity = '🟢 Low';
    } else if (info.gas < GAS_THRESHOLDS.medium) {
      complexity = '🟡 Medium';
    } else if (info.gas < GAS_THRESHOLDS.high) {
      complexity = '🟠 High';
    } else {
      complexity = '🔴 Very High';
    }
    md.appendMarkdown(`**Complexity:** ${complexity}\n\n`);
  }

  // Selector
  md.appendMarkdown(`**Selector:** \`${info.selector}\`\n\n`);

  // Visibility and mutability
  md.appendMarkdown(
    `**Visibility:** ${info.visibility} | **Mutability:** ${info.stateMutability}\n\n`
  );

  // Warnings
  if (info.warnings.length > 0) {
    md.appendMarkdown('---\n\n');
    md.appendMarkdown('**Warnings:**\n\n');
    for (const warning of info.warnings) {
      md.appendMarkdown(`- ${warning}\n`);
    }
  }

  return md;
}

/**
 * Apply gas decorations to editor
 *
 * @param editor - VS Code text editor
 * @param gasInfo - Array of gas information
 */
export function applyGasDecorations(editor: vscode.TextEditor, gasInfo: GasInfo[]): void {
  const decorations = createGasDecorations(gasInfo, editor.document);

  // Apply each decoration type
  for (const [decorationType, options] of decorations) {
    editor.setDecorations(decorationType, options);
  }
}

/**
 * Clear gas decorations from editor
 *
 * @param editor - VS Code text editor
 */
export function clearGasDecorations(editor: vscode.TextEditor): void {
  for (const decorationType of decorationTypeCache.values()) {
    editor.setDecorations(decorationType, []);
  }
}

/**
 * GasDecorationManager - Manages decoration lifecycle with debouncing
 *
 * Features:
 * - Per-document decoration tracking
 * - Debounced updates (250-500ms)
 * - Automatic cleanup on editor close
 * - Never clears decorations until new ones are ready
 */
export class GasDecorationManager {
  private static instance: GasDecorationManager;

  private updateTimers = new Map<string, NodeJS.Timeout>();
  private lastGasInfo = new Map<string, GasInfo[]>();
  private debounceMs: number;

  private constructor(debounceMs = 300) {
    this.debounceMs = debounceMs;
  }

  /**
   * Get singleton instance
   */
  static getInstance(debounceMs?: number): GasDecorationManager {
    if (!this.instance) {
      this.instance = new GasDecorationManager(debounceMs);
    }
    return this.instance;
  }

  /**
   * Update decorations for an editor (debounced)
   */
  updateDecorations(editor: vscode.TextEditor, gasInfo: GasInfo[]): void {
    const uri = editor.document.uri.toString();

    // Store gas info (even if debounced)
    this.lastGasInfo.set(uri, gasInfo);

    // Clear previous timer
    const existingTimer = this.updateTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer — capture only the URI to avoid pinning the full document/gasInfo in the closure
    const timer = setTimeout(() => {
      this.updateTimers.delete(uri);
      const activeEditor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri
      );
      const latestGasInfo = this.lastGasInfo.get(uri);
      if (activeEditor && latestGasInfo) {
        this.applyDecorationsNow(activeEditor, latestGasInfo);
      }
    }, this.debounceMs);

    this.updateTimers.set(uri, timer);
  }

  /**
   * Apply decorations immediately (no debounce)
   */
  applyDecorationsNow(editor: vscode.TextEditor, gasInfo: GasInfo[]): void {
    applyGasDecorations(editor, gasInfo);
  }

  /**
   * Get last gas info for a document
   */
  getLastGasInfo(uri: string): GasInfo[] | undefined {
    return this.lastGasInfo.get(uri);
  }

  /**
   * Clear decorations for a document
   */
  clearDecorations(editor: vscode.TextEditor): void {
    const uri = editor.document.uri.toString();

    // Clear timer
    const timer = this.updateTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.updateTimers.delete(uri);
    }

    // Clear stored info
    this.lastGasInfo.delete(uri);

    // Clear actual decorations
    clearGasDecorations(editor);
  }

  /**
   * Dispose manager (cleanup all resources)
   */
  dispose(): void {
    // Clear all timers
    for (const timer of this.updateTimers.values()) {
      clearTimeout(timer);
    }
    this.updateTimers.clear();
    this.lastGasInfo.clear();

    // Clear decoration types
    clearDecorationTypes();
  }
}

/**
 * Create diagnostic warnings from GasInfo
 * These appear in the Problems panel
 */
export function createGasDiagnostics(
  gasInfo: GasInfo[],
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const info of gasInfo) {
    // Create warning for infinite gas
    if (info.gas === 'infinite') {
      const line = info.loc.line - 1;
      if (line >= 0 && line < document.lineCount) {
        const range = document.lineAt(line).range;
        const diagnostic = new vscode.Diagnostic(
          range,
          `Function '${info.name}' has unbounded gas consumption`,
          vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = '0xTools';
        diagnostic.code = 'unbounded-gas';
        diagnostics.push(diagnostic);
      }
    }

    // Create warnings for each detected issue
    for (const warning of info.warnings) {
      const line = info.loc.line - 1;
      if (line >= 0 && line < document.lineCount) {
        const range = document.lineAt(line).range;
        const diagnostic = new vscode.Diagnostic(
          range,
          `${info.name}: ${warning}`,
          vscode.DiagnosticSeverity.Information
        );
        diagnostic.source = '0xTools';
        diagnostic.code = 'gas-warning';
        diagnostics.push(diagnostic);
      }
    }

    // Warning for very high gas
    if (typeof info.gas === 'number' && info.gas > GAS_THRESHOLDS.high) {
      const line = info.loc.line - 1;
      if (line >= 0 && line < document.lineCount) {
        const range = document.lineAt(line).range;
        const diagnostic = new vscode.Diagnostic(
          range,
          `Function '${info.name}' has very high gas cost (${info.gas.toLocaleString()} gas)`,
          vscode.DiagnosticSeverity.Hint
        );
        diagnostic.source = '0xTools';
        diagnostic.code = 'high-gas';
        diagnostics.push(diagnostic);
      }
    }
  }

  return diagnostics;
}
