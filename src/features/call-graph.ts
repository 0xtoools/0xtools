/**
 * Function Call Graph Analyzer - Lightweight dependency mapping
 * Visual dependency mapping without heavy AST parsing
 */

import * as vscode from 'vscode';

export interface FunctionNode {
  name: string;
  signature: string;
  visibility: 'public' | 'external' | 'internal' | 'private';
  isView: boolean;
  isPure: boolean;
  isPayable: boolean;
  calls: string[]; // Functions this function calls
  calledBy: string[]; // Functions that call this function
  externalCalls: ExternalCall[];
  recursionDepth: number; // 0 = no recursion, >0 = recursive
  gasImpact: 'low' | 'medium' | 'high'; // Based on call depth and external calls
}

export interface ExternalCall {
  target: string; // Contract or address
  function: string;
  isDelegate: boolean; // delegatecall vs call
  line: number;
}

export interface CallGraph {
  functions: Map<string, FunctionNode>;
  entryPoints: string[]; // Public/external functions
  internalOnly: string[]; // Functions only called internally
  recursive: string[]; // Functions with recursion
  externalCallSites: number; // Total external calls
  maxCallDepth: number;
}

// Pre-compiled regex patterns — hoisted to module scope to avoid re-compilation per call
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_LINE_COMMENT = /\/\/.*/g;
const RE_FUNC_DECL =
  /function\s+(\w+)\s*\(([^)]*)\)\s*(public|external|internal|private)?\s*([\w\s,]*?)\s*(?:returns\s*\([^)]*\))?\s*{/g;
const RE_INTERNAL_CALL = /\b(\w+)\s*\(/g;
const RE_EXTERNAL_CALL = /(\w+)\.(\w+)\s*\(/g;

export class CallGraphAnalyzer {
  /**
   * Analyze call graph from contract code (regex-based, lightweight)
   */
  public analyzeContract(contractCode: string): CallGraph {
    const functions = this.extractFunctions(contractCode);
    const callMap = this.buildCallGraph(functions, contractCode);
    const entryPoints = this.findEntryPoints(callMap);
    const internalOnly = this.findInternalOnly(callMap, entryPoints);
    const recursive = this.detectRecursion(callMap);
    const maxDepth = this.calculateMaxDepth(callMap);
    const externalCalls = this.countExternalCalls(callMap);

    return {
      functions: callMap,
      entryPoints,
      internalOnly,
      recursive,
      externalCallSites: externalCalls,
      maxCallDepth: maxDepth,
    };
  }

  /**
   * Extract function signatures (lightweight regex)
   */
  private extractFunctions(code: string): Array<{
    name: string;
    signature: string;
    visibility: string;
    modifiers: string[];
    body: string;
    line: number;
  }> {
    const functions: Array<{
      name: string;
      signature: string;
      visibility: string;
      modifiers: string[];
      body: string;
      line: number;
    }> = [];

    // Remove comments
    const cleanCode = code.replace(RE_BLOCK_COMMENT, '').replace(RE_LINE_COMMENT, '');

    // Match function declarations
    RE_FUNC_DECL.lastIndex = 0;

    let match;
    while ((match = RE_FUNC_DECL.exec(cleanCode)) !== null) {
      const [fullMatch, name, params, visibility, modifiersStr] = match;
      const modifiers = modifiersStr
        ? modifiersStr.split(/\s+/).filter((m) => m.trim().length > 0)
        : [];

      // Extract function body (find matching closing brace)
      const bodyStart = match.index + fullMatch.length;
      const body = this.extractFunctionBody(cleanCode, bodyStart);
      const lineNumber = cleanCode.substring(0, match.index).split('\n').length;

      functions.push({
        name,
        signature: `${name}(${params})`,
        visibility: visibility || 'public',
        modifiers,
        body,
        line: lineNumber,
      });
    }

    return functions;
  }

  /**
   * Extract function body by matching braces
   */
  private extractFunctionBody(code: string, startIndex: number): string {
    let depth = 1;
    let endIndex = startIndex;

    for (let i = startIndex; i < code.length && depth > 0; i++) {
      if (code[i] === '{') {
        depth++;
      }
      if (code[i] === '}') {
        depth--;
      }
      endIndex = i;
    }

    return code.substring(startIndex, endIndex);
  }

  /**
   * Build call graph from functions
   */
  private buildCallGraph(
    functions: Array<{
      name: string;
      signature: string;
      visibility: string;
      modifiers: string[];
      body: string;
      line: number;
    }>,
    fullCode: string
  ): Map<string, FunctionNode> {
    const graph = new Map<string, FunctionNode>();

    // Initialize nodes
    functions.forEach((func) => {
      const node: FunctionNode = {
        name: func.name,
        signature: func.signature,
        visibility: func.visibility as 'public' | 'external' | 'internal' | 'private',
        isView: func.modifiers.includes('view'),
        isPure: func.modifiers.includes('pure'),
        isPayable: func.modifiers.includes('payable'),
        calls: [],
        calledBy: [],
        externalCalls: [],
        recursionDepth: 0,
        gasImpact: 'low',
      };
      graph.set(func.name, node);
    });

    // Build edges (function calls)
    functions.forEach((func) => {
      const caller = graph.get(func.name)!;

      // Find internal function calls
      RE_INTERNAL_CALL.lastIndex = 0;
      let callMatch;
      while ((callMatch = RE_INTERNAL_CALL.exec(func.body)) !== null) {
        const calleeName = callMatch[1];
        if (graph.has(calleeName) && calleeName !== func.name) {
          caller.calls.push(calleeName);
          graph.get(calleeName)!.calledBy.push(func.name);
        }
      }

      // Find external calls
      RE_EXTERNAL_CALL.lastIndex = 0;
      let extMatch;
      while ((extMatch = RE_EXTERNAL_CALL.exec(func.body)) !== null) {
        const [, target, method] = extMatch;
        const isDelegate = func.body.includes(`${target}.delegatecall`);

        caller.externalCalls.push({
          target,
          function: method,
          isDelegate,
          line: func.line + func.body.substring(0, extMatch.index).split('\n').length,
        });
      }
    });

    // Calculate gas impact
    graph.forEach((node) => {
      const callDepth = this.calculateCallDepth(node, graph);
      const externalCount = node.externalCalls.length;

      if (externalCount > 2 || callDepth > 3) {
        node.gasImpact = 'high';
      } else if (externalCount > 0 || callDepth > 1) {
        node.gasImpact = 'medium';
      } else {
        node.gasImpact = 'low';
      }
    });

    return graph;
  }

  /**
   * Calculate call depth for a function
   */
  private calculateCallDepth(
    node: FunctionNode,
    graph: Map<string, FunctionNode>,
    visited = new Set<string>()
  ): number {
    if (visited.has(node.name)) {
      return 0;
    }
    visited.add(node.name);

    if (node.calls.length === 0) {
      return 0;
    }

    let maxDepth = 0;
    for (const callee of node.calls) {
      const calleeNode = graph.get(callee);
      if (calleeNode) {
        const depth = 1 + this.calculateCallDepth(calleeNode, graph, new Set(visited));
        maxDepth = Math.max(maxDepth, depth);
      }
    }

    return maxDepth;
  }

  /**
   * Find entry point functions (public/external)
   */
  private findEntryPoints(graph: Map<string, FunctionNode>): string[] {
    return Array.from(graph.values())
      .filter((node) => node.visibility === 'public' || node.visibility === 'external')
      .map((node) => node.name);
  }

  /**
   * Find functions only called internally
   */
  private findInternalOnly(graph: Map<string, FunctionNode>, entryPoints: string[]): string[] {
    const reachableFromExternal = new Set<string>();

    // DFS from each entry point
    const dfs = (name: string, visited: Set<string>) => {
      if (visited.has(name)) {
        return;
      }
      visited.add(name);
      reachableFromExternal.add(name);

      const node = graph.get(name);
      if (node) {
        node.calls.forEach((callee) => dfs(callee, visited));
      }
    };

    entryPoints.forEach((entry) => dfs(entry, new Set()));

    // Functions not reachable from external = internal only
    return Array.from(graph.keys()).filter((name) => !reachableFromExternal.has(name));
  }

  /**
   * Detect recursive functions
   */
  private detectRecursion(graph: Map<string, FunctionNode>): string[] {
    const recursive: string[] = [];

    const detectCycle = (name: string, path: Set<string>): boolean => {
      if (path.has(name)) {
        const node = graph.get(name);
        if (node) {
          node.recursionDepth = path.size;
        }
        return true;
      }

      path.add(name);
      const node = graph.get(name);
      if (!node) {
        path.delete(name);
        return false;
      }

      let foundRecursion = false;
      for (const callee of node.calls) {
        if (detectCycle(callee, new Set(path))) {
          foundRecursion = true;
        }
      }

      path.delete(name);
      return foundRecursion;
    };

    graph.forEach((_, name) => {
      if (detectCycle(name, new Set())) {
        recursive.push(name);
      }
    });

    return recursive;
  }

  /**
   * Calculate maximum call depth in graph
   */
  private calculateMaxDepth(graph: Map<string, FunctionNode>): number {
    let maxDepth = 0;
    graph.forEach((node) => {
      const depth = this.calculateCallDepth(node, graph);
      maxDepth = Math.max(maxDepth, depth);
    });
    return maxDepth;
  }

  /**
   * Count total external calls
   */
  private countExternalCalls(graph: Map<string, FunctionNode>): number {
    let count = 0;
    graph.forEach((node) => {
      count += node.externalCalls.length;
    });
    return count;
  }

  /**
   * Generate markdown report
   */
  public generateReport(callGraph: CallGraph, contractName: string): string {
    let report = `# 🔗 Call Graph Analysis: ${contractName}\n\n`;

    // Summary
    report += `## 📊 Summary\n\n`;
    report += `- **Total Functions**: ${callGraph.functions.size}\n`;
    report += `- **Entry Points**: ${callGraph.entryPoints.length}\n`;
    report += `- **Internal Only**: ${callGraph.internalOnly.length}\n`;
    report += `- **Recursive Functions**: ${callGraph.recursive.length}\n`;
    report += `- **External Calls**: ${callGraph.externalCallSites}\n`;
    report += `- **Max Call Depth**: ${callGraph.maxCallDepth}\n\n`;

    // Entry points
    if (callGraph.entryPoints.length > 0) {
      report += `## 🚪 Entry Points (Public/External)\n\n`;
      callGraph.entryPoints.forEach((name) => {
        const node = callGraph.functions.get(name)!;
        const modifiers = [];
        if (node.isView) {
          modifiers.push('view');
        }
        if (node.isPure) {
          modifiers.push('pure');
        }
        if (node.isPayable) {
          modifiers.push('payable');
        }

        report += `### ${node.signature}\n`;
        report += `- Visibility: ${node.visibility}`;
        if (modifiers.length > 0) {
          report += ` (${modifiers.join(', ')})`;
        }
        report += '\n';
        if (node.calls.length > 0) {
          report += `- Calls: ${node.calls.join(', ')}\n`;
        }
        if (node.externalCalls.length > 0) {
          report += `- External Calls: ${node.externalCalls.length}\n`;
          node.externalCalls.forEach((call) => {
            report += `  - ${call.target}.${call.function}()${call.isDelegate ? ' (delegatecall)' : ''}\n`;
          });
        }
        report += `- Gas Impact: ${node.gasImpact.toUpperCase()}\n\n`;
      });
    }

    // Recursive functions
    if (callGraph.recursive.length > 0) {
      report += `## 🔄 Recursive Functions (⚠️ Unbounded Gas)\n\n`;
      callGraph.recursive.forEach((name) => {
        const node = callGraph.functions.get(name)!;
        report += `- **${name}**: Recursion depth ${node.recursionDepth}\n`;
      });
      report += '\n';
    }

    // High gas impact functions
    const highGasFunctions = Array.from(callGraph.functions.values()).filter(
      (n) => n.gasImpact === 'high'
    );
    if (highGasFunctions.length > 0) {
      report += `## ⚠️ High Gas Impact Functions\n\n`;
      highGasFunctions.forEach((node) => {
        report += `### ${node.name}\n`;
        report += `- External calls: ${node.externalCalls.length}\n`;
        report += `- Internal calls: ${node.calls.length}\n`;
        if (node.calls.length > 0) {
          report += `- Call chain: ${node.name} → ${node.calls.join(' → ')}\n`;
        }
        report += '\n';
      });
    }

    // Call hierarchy
    report += `## 📊 Call Hierarchy\n\n`;
    report += '```\n';
    const printed = new Set<string>();
    const printHierarchy = (name: string, indent: number, visited: Set<string>) => {
      if (visited.has(name) || printed.has(name)) {
        report += `${'  '.repeat(indent)}${name} (circular)\n`;
        return;
      }
      visited.add(name);
      printed.add(name);

      const node = callGraph.functions.get(name);
      if (!node) {
        return;
      }

      const gasIcon = node.gasImpact === 'high' ? '🔴' : node.gasImpact === 'medium' ? '🟡' : '🟢';
      report += `${'  '.repeat(indent)}${gasIcon} ${name}`;
      if (node.externalCalls.length > 0) {
        report += ` [${node.externalCalls.length} ext]`;
      }
      report += '\n';

      node.calls.forEach((callee) => {
        printHierarchy(callee, indent + 1, new Set(visited));
      });
    };

    callGraph.entryPoints.forEach((entry) => {
      printHierarchy(entry, 0, new Set());
    });
    report += '```\n\n';

    return report;
  }

  /**
   * Create inline decorations for call annotations
   */
  public createCallDecorations(
    callGraph: CallGraph,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    callGraph.functions.forEach((node, name) => {
      // Find function declaration
      const pattern = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)`);
      const match = pattern.exec(content);

      if (match) {
        const position = document.positionAt(match.index + match[0].length);

        const gasIcon =
          node.gasImpact === 'high' ? '🔴' : node.gasImpact === 'medium' ? '🟡' : '🟢';
        const extInfo = node.externalCalls.length > 0 ? `, ${node.externalCalls.length} ext` : '';
        const recursiveInfo = node.recursionDepth > 0 ? ' ♻️' : '';

        const decoration: vscode.DecorationOptions = {
          range: new vscode.Range(position, position),
          renderOptions: {
            after: {
              contentText: ` ${gasIcon} ${node.calls.length} calls${extInfo}${recursiveInfo}`,
              color: node.gasImpact === 'high' ? '#ef4444' : '#94a3b8',
              fontStyle: 'italic',
              margin: '0 0 0 1em',
            },
          },
          hoverMessage: new vscode.MarkdownString(
            `**Call Graph for ${name}**\n\n` +
              `- Gas Impact: **${node.gasImpact.toUpperCase()}**\n` +
              `- Internal Calls: ${node.calls.length}\n` +
              `- External Calls: ${node.externalCalls.length}\n` +
              `- Called By: ${node.calledBy.length > 0 ? node.calledBy.join(', ') : 'none'}\n` +
              (node.calls.length > 0 ? `\n**Calls**: ${node.calls.join(', ')}` : '') +
              (node.recursionDepth > 0
                ? `\n\n⚠️ **Recursive** (depth ${node.recursionDepth})`
                : '') +
              (node.externalCalls.length > 0
                ? `\n\n**External Calls**:\n${node.externalCalls.map((c) => `- ${c.target}.${c.function}()`).join('\n')}`
                : '')
          ),
        };

        decorations.push(decoration);
      }
    });

    return decorations;
  }
}
