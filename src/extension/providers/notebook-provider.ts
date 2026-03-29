/**
 * 0xTools Notebook Provider - VS Code notebook support for .sigscan files
 *
 * Provides a custom notebook serializer and execution controller for
 * interactive Solidity analysis notebooks. The .sigscan file format is
 * a simple JSON structure with markdown and code cells.
 *
 * Supported code cell commands:
 *   scan <path>        - Scan a path for contract signatures
 *   gas <path>         - Estimate gas for contracts at path
 *   abi <path>         - Generate ABI for contracts at path
 *   size <path>        - Check contract sizes against 24KB limit
 *   complexity <path>  - Analyze cyclomatic complexity
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Notebook cell format (persisted as JSON in .sigscan files)
// ---------------------------------------------------------------------------

interface SigScanNotebookCell {
  kind: 'markdown' | 'code';
  value: string;
  outputs?: Array<{ text: string }>;
}

interface SigScanNotebookDocument {
  cells: SigScanNotebookCell[];
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serializes and deserializes .sigscan notebook files.
 */
export class SigScanNotebookSerializer implements vscode.NotebookSerializer {
  /**
   * Parse a .sigscan JSON file into a NotebookData structure.
   */
  public deserializeNotebook(
    data: Uint8Array,
    _token: vscode.CancellationToken
  ): vscode.NotebookData {
    const text = new TextDecoder().decode(data);

    let doc: SigScanNotebookDocument;
    try {
      doc = JSON.parse(text);
    } catch {
      // If parsing fails, create a single markdown cell with the raw content
      return new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          text || '# 0xTools Notebook\n\nAdd code cells with commands like `scan ./contracts`.',
          'markdown'
        ),
      ]);
    }

    if (!doc.cells || !Array.isArray(doc.cells)) {
      return new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          '# 0xTools Notebook',
          'markdown'
        ),
      ]);
    }

    const cells: vscode.NotebookCellData[] = doc.cells.map((cell) => {
      const kind =
        cell.kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;

      const languageId = cell.kind === 'code' ? 'sigscan' : 'markdown';
      const cellData = new vscode.NotebookCellData(kind, cell.value || '', languageId);

      // Restore outputs if present
      if (cell.outputs && cell.outputs.length > 0) {
        cellData.outputs = cell.outputs.map(
          (out) =>
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(out.text, 'text/plain'),
            ])
        );
      }

      return cellData;
    });

    return new vscode.NotebookData(cells);
  }

  /**
   * Serialize a NotebookData structure back to .sigscan JSON.
   */
  public serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken
  ): Uint8Array {
    const doc: SigScanNotebookDocument = {
      cells: data.cells.map((cell) => {
        const kind = cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown';

        const outputs: Array<{ text: string }> = [];
        if (cell.outputs) {
          for (const output of cell.outputs) {
            for (const item of output.items) {
              if (item.mime === 'text/plain') {
                outputs.push({ text: new TextDecoder().decode(item.data) });
              }
            }
          }
        }

        const serialized: SigScanNotebookCell = {
          kind,
          value: cell.value,
        };

        if (outputs.length > 0) {
          serialized.outputs = outputs;
        }

        return serialized;
      }),
    };

    const json = JSON.stringify(doc, null, 2);
    return new TextEncoder().encode(json);
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Executes code cells in .sigscan notebooks.
 *
 * Supported commands:
 *   scan <path>
 *   gas <path>
 *   abi <path>
 *   size <path>
 *   complexity <path>
 */
export class SigScanNotebookController {
  public static readonly controllerId = 'sigscan-notebook-controller';
  public static readonly notebookType = 'sigscan-notebook';
  public static readonly label = '0xTools';

  private readonly controller: vscode.NotebookController;
  private executionOrder = 0;
  private keccak256: ((input: string) => string) | null = null;
  private keccak256Resolved = false;

  constructor() {
    this.controller = vscode.notebooks.createNotebookController(
      SigScanNotebookController.controllerId,
      SigScanNotebookController.notebookType,
      SigScanNotebookController.label
    );

    this.controller.supportedLanguages = ['sigscan'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = this.executeAll.bind(this);
  }

  /**
   * Execute one or more notebook cells.
   */
  private async executeAll(
    cells: vscode.NotebookCell[],
    _notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController
  ): Promise<void> {
    for (const cell of cells) {
      await this.executeCell(cell);
    }
  }

  /**
   * Execute a single code cell.
   */
  private async executeCell(cell: vscode.NotebookCell): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());

    const rawText = cell.document.getText().trim();
    if (!rawText) {
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text('Empty cell - nothing to execute.', 'text/plain'),
        ]),
      ]);
      execution.end(true, Date.now());
      return;
    }

    // Parse command and arguments
    const parts = rawText.split(/\s+/);
    const command = parts[0].toLowerCase();
    const targetPath = parts.slice(1).join(' ') || '.';

    try {
      const result = await this.runCommand(command, targetPath, cell);
      execution.replaceOutput([
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(result, 'text/plain')]),
      ]);
      execution.end(true, Date.now());
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(new Error(`Command failed: ${errorMsg}`)),
        ]),
      ]);
      execution.end(false, Date.now());
    }
  }

  /**
   * Route a command to the appropriate handler.
   */
  private async runCommand(
    command: string,
    targetPath: string,
    cell: vscode.NotebookCell
  ): Promise<string> {
    // Resolve the target path relative to the notebook file
    const notebookDir = path.dirname(cell.notebook.uri.fsPath);
    const resolvedPath = path.resolve(notebookDir, targetPath);

    switch (command) {
      case 'scan':
        return this.commandScan(resolvedPath);
      case 'gas':
        return this.commandGas(resolvedPath);
      case 'abi':
        return this.commandAbi(resolvedPath);
      case 'size':
        return this.commandSize(resolvedPath);
      case 'complexity':
        return this.commandComplexity(resolvedPath);
      default:
        return [
          `Unknown command: "${command}"`,
          '',
          'Supported commands:',
          '  scan <path>        Scan for contract signatures',
          '  gas <path>         Estimate gas costs',
          '  abi <path>         Generate ABI',
          '  size <path>        Check contract sizes (24KB limit)',
          '  complexity <path>  Analyze cyclomatic complexity',
        ].join('\n');
    }
  }

  // ---------------------------------------------------------------------------
  // Command implementations
  // ---------------------------------------------------------------------------

  private async commandScan(targetPath: string): Promise<string> {
    const files = this.findSolFiles(targetPath);
    if (files.length === 0) {
      return `No .sol files found in: ${targetPath}`;
    }

    const lines: string[] = [
      `=== Scan Results ===`,
      `Path: ${targetPath}`,
      `Files found: ${files.length}`,
      '',
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const contracts = this.extractContractNames(source);
      const functions = this.extractFunctionSignatures(source);
      const events = this.extractEventSignatures(source);

      lines.push(`--- ${path.basename(file)} ---`);
      for (const contract of contracts) {
        lines.push(`  Contract: ${contract}`);
      }
      for (const fn of functions) {
        lines.push(`  Function: ${fn.signature}  =>  ${fn.selector}`);
      }
      for (const ev of events) {
        lines.push(`  Event:    ${ev.signature}  =>  ${ev.topic}`);
      }
      lines.push('');
    }

    lines.push(`Total: ${files.length} file(s) scanned`);
    return lines.join('\n');
  }

  private async commandGas(targetPath: string): Promise<string> {
    const files = this.findSolFiles(targetPath);
    if (files.length === 0) {
      return `No .sol files found in: ${targetPath}`;
    }

    const lines: string[] = [
      `=== Gas Estimates ===`,
      `Path: ${targetPath}`,
      '',
      'Note: Accurate gas requires compilation. These are heuristic estimates.',
      '',
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const functions = this.extractFunctionSignatures(source);

      if (functions.length > 0) {
        lines.push(`--- ${path.basename(file)} ---`);
        for (const fn of functions) {
          const estimate = this.heuristicGas(source, fn.name);
          lines.push(`  ${fn.signature.padEnd(50)} ~${estimate.toLocaleString()} gas`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private async commandAbi(targetPath: string): Promise<string> {
    const files = this.findSolFiles(targetPath);
    if (files.length === 0) {
      return `No .sol files found in: ${targetPath}`;
    }

    const lines: string[] = [`=== ABI Generation ===`, ''];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const functions = this.extractFunctionSignatures(source);
      const events = this.extractEventSignatures(source);

      if (functions.length === 0 && events.length === 0) {
        continue;
      }

      lines.push(`--- ${path.basename(file)} ---`);

      // Build a simplified ABI array
      const abi: Array<Record<string, unknown>> = [];

      for (const fn of functions) {
        abi.push({
          type: 'function',
          name: fn.name,
          inputs: fn.inputs.map((inp) => ({ name: inp.name, type: inp.type })),
          stateMutability: fn.stateMutability || 'nonpayable',
        });
      }

      for (const ev of events) {
        abi.push({
          type: 'event',
          name: ev.name,
          inputs: ev.inputs.map((inp) => ({
            name: inp.name,
            type: inp.type,
            indexed: inp.indexed || false,
          })),
        });
      }

      lines.push(JSON.stringify(abi, null, 2));
      lines.push('');
    }

    return lines.join('\n');
  }

  private async commandSize(targetPath: string): Promise<string> {
    const files = this.findSolFiles(targetPath);
    if (files.length === 0) {
      return `No .sol files found in: ${targetPath}`;
    }

    const LIMIT = 24_576; // EIP-170

    const lines: string[] = [
      `=== Contract Size Analysis ===`,
      `EIP-170 Limit: ${LIMIT.toLocaleString()} bytes`,
      '',
      'Note: Sizes below are source-based estimates. Actual bytecode size requires compilation.',
      '',
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const contracts = this.extractContractNames(source);
      // Rough estimate: source bytes * 0.6 as a placeholder
      const estimatedSize = Math.round(Buffer.byteLength(source, 'utf-8') * 0.6);
      const status = estimatedSize <= LIMIT ? 'OK' : 'WARNING';

      for (const contract of contracts) {
        const statusMark = status === 'OK' ? '[OK]     ' : '[WARNING]';
        lines.push(
          `  ${statusMark} ${contract.padEnd(30)} ~${estimatedSize.toLocaleString()} bytes`
        );
      }
    }

    return lines.join('\n');
  }

  private async commandComplexity(targetPath: string): Promise<string> {
    const files = this.findSolFiles(targetPath);
    if (files.length === 0) {
      return `No .sol files found in: ${targetPath}`;
    }

    const lines: string[] = [
      `=== Complexity Analysis ===`,
      'Ratings: Low (1-5) | Medium (6-10) | High (11-20) | Very High (21+)',
      '',
    ];

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const functions = this.extractFunctionSignatures(source);

      if (functions.length > 0) {
        lines.push(`--- ${path.basename(file)} ---`);
        for (const fn of functions) {
          const cc = this.cyclomaticComplexity(source, fn.name);
          const rating = cc <= 5 ? 'Low' : cc <= 10 ? 'Medium' : cc <= 20 ? 'High' : 'Very High';
          lines.push(`  [${rating.padEnd(9)}] ${fn.signature.padEnd(50)} CC=${cc}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Hashing helper (resolved once, cached for all subsequent calls)
  // ---------------------------------------------------------------------------

  private getKeccak256(): ((input: string) => string) | null {
    if (!this.keccak256Resolved) {
      this.keccak256Resolved = true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { keccak256 } = require('js-sha3');
        this.keccak256 = keccak256;
      } catch {
        // js-sha3 not available
        this.keccak256 = null;
      }
    }
    return this.keccak256;
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers (lightweight regex, no solc dependency)
  // ---------------------------------------------------------------------------

  private findSolFiles(targetPath: string): string[] {
    const results: string[] = [];

    if (!fs.existsSync(targetPath)) {
      return results;
    }

    const stat = fs.statSync(targetPath);
    if (stat.isFile() && targetPath.endsWith('.sol')) {
      return [targetPath];
    }

    if (!stat.isDirectory()) {
      return results;
    }

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip common non-source directories
          if (['node_modules', 'lib', '.git', 'cache', 'artifacts', 'out'].includes(entry.name)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.sol')) {
          results.push(fullPath);
        }
      }
    };

    walk(targetPath);
    return results;
  }

  private extractContractNames(source: string): string[] {
    const names: string[] = [];
    const regex = /(?:contract|library|interface)\s+(\w+)/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      names.push(match[1]);
    }
    return names;
  }

  private extractFunctionSignatures(source: string): Array<{
    name: string;
    signature: string;
    selector: string;
    stateMutability: string;
    inputs: Array<{ name: string; type: string }>;
  }> {
    const results: Array<{
      name: string;
      signature: string;
      selector: string;
      stateMutability: string;
      inputs: Array<{ name: string; type: string }>;
    }> = [];

    const regex =
      /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*(pure|view|payable|nonpayable)?/g;

    let match;
    while ((match = regex.exec(source)) !== null) {
      const [, name, paramsStr, , stateMutability = 'nonpayable'] = match;

      const inputs = this.parseParams(paramsStr);
      const typeOnly = inputs.map((p) => p.type);
      const signature = `${name}(${typeOnly.join(',')})`;

      // Compute selector via simple keccak256 (use js-sha3 if available)
      let selector = '0x????????';
      const hashFn = this.getKeccak256();
      if (hashFn) {
        selector = '0x' + hashFn(signature).substring(0, 8);
      }

      results.push({ name, signature, selector, stateMutability, inputs });
    }

    return results;
  }

  private extractEventSignatures(source: string): Array<{
    name: string;
    signature: string;
    topic: string;
    inputs: Array<{ name: string; type: string; indexed: boolean }>;
  }> {
    const results: Array<{
      name: string;
      signature: string;
      topic: string;
      inputs: Array<{ name: string; type: string; indexed: boolean }>;
    }> = [];

    const regex = /event\s+(\w+)\s*\(([^)]*)\)\s*;/g;

    let match;
    while ((match = regex.exec(source)) !== null) {
      const [, name, paramsStr] = match;

      const inputs = this.parseEventParams(paramsStr);
      const typeOnly = inputs.map((p) => p.type);
      const signature = `${name}(${typeOnly.join(',')})`;

      let topic = '0x' + '?'.repeat(64);
      const hashFn2 = this.getKeccak256();
      if (hashFn2) {
        topic = '0x' + hashFn2(signature);
      }

      results.push({ name, signature, topic, inputs });
    }

    return results;
  }

  private parseParams(paramsStr: string): Array<{ name: string; type: string }> {
    if (!paramsStr.trim()) {
      return [];
    }

    return paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const parts = param
          .replace(/\b(memory|storage|calldata)\b/g, '')
          .trim()
          .split(/\s+/)
          .filter((p) => p.length > 0);
        const type = parts[0] || 'unknown';
        const name = parts.length > 1 ? parts[parts.length - 1] : '';
        return { name, type };
      });
  }

  private parseEventParams(
    paramsStr: string
  ): Array<{ name: string; type: string; indexed: boolean }> {
    if (!paramsStr.trim()) {
      return [];
    }

    return paramsStr
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((param) => {
        const indexed = /\bindexed\b/.test(param);
        const cleaned = param
          .replace(/\bindexed\b/g, '')
          .replace(/\b(memory|storage|calldata)\b/g, '')
          .trim();
        const parts = cleaned.split(/\s+/).filter((p) => p.length > 0);
        const type = parts[0] || 'unknown';
        const name = parts.length > 1 ? parts[parts.length - 1] : '';
        return { name, type, indexed };
      });
  }

  /**
   * Rough heuristic gas estimate based on function body complexity.
   */
  private heuristicGas(source: string, funcName: string): number {
    const fnRegex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)[^{]*\\{`, 's');
    const match = fnRegex.exec(source);
    if (!match) {
      return 21_000; // Base transaction cost
    }

    // Extract function body
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let i = startIdx;
    while (i < source.length && braceCount > 0) {
      if (source[i] === '{') {
        braceCount++;
      }
      if (source[i] === '}') {
        braceCount--;
      }
      i++;
    }
    const body = source.substring(startIdx, i - 1);

    // Base cost
    let gas = 21_000;

    // SSTORE operations (most expensive)
    const sstoreCount = (body.match(/\b\w+\s*=/g) || []).length;
    gas += sstoreCount * 5_000;

    // External calls
    const callCount = (body.match(/\.\w+\s*\(/g) || []).length;
    gas += callCount * 2_600;

    // Loops
    const loopCount = (body.match(/\b(for|while)\s*\(/g) || []).length;
    gas += loopCount * 10_000;

    // Conditionals
    const condCount = (body.match(/\bif\s*\(/g) || []).length;
    gas += condCount * 200;

    return gas;
  }

  /**
   * Approximate cyclomatic complexity from function body.
   */
  private cyclomaticComplexity(source: string, funcName: string): number {
    const fnRegex = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)[^{]*\\{`, 's');
    const match = fnRegex.exec(source);
    if (!match) {
      return 1;
    }

    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let i = startIdx;
    while (i < source.length && braceCount > 0) {
      if (source[i] === '{') {
        braceCount++;
      }
      if (source[i] === '}') {
        braceCount--;
      }
      i++;
    }
    const body = source.substring(startIdx, i - 1);

    let cc = 1; // Base complexity
    cc += (body.match(/\bif\b/g) || []).length;
    cc += (body.match(/\belse\s+if\b/g) || []).length;
    cc += (body.match(/\bfor\b/g) || []).length;
    cc += (body.match(/\bwhile\b/g) || []).length;
    cc += (body.match(/\brequire\b/g) || []).length;
    cc += (body.match(/\bassert\b/g) || []).length;
    cc += (body.match(/\b\?\s*/g) || []).length; // ternary
    cc += (body.match(/&&/g) || []).length;
    cc += (body.match(/\|\|/g) || []).length;

    return cc;
  }

  /**
   * Dispose the controller.
   */
  public dispose(): void {
    this.controller.dispose();
  }
}
