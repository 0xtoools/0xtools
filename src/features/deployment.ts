/**
 * Deployment Cost Estimator - Lightweight deployment gas estimation
 * Calculates total ownership cost without heavy compilation
 */

import * as vscode from 'vscode';

export interface DeploymentCost {
  contractName: string;
  bytecodeSize: number; // Estimated in bytes
  initCodeSize: number; // Constructor + creation code
  deploymentGas: {
    creation: number; // CREATE/CREATE2 opcode
    codeDeposit: number; // 200 gas per byte
    constructor: number; // Constructor execution
    total: number;
  };
  costInEth: {
    at50Gwei: string;
    at100Gwei: string;
    at200Gwei: string;
  };
  optimizationImpact: {
    withOptimizer: number; // Estimated savings with optimizer
    withoutOptimizer: number;
  };
  factoryPattern?: {
    clonePattern: boolean; // EIP-1167 minimal proxy
    estimatedSavings: number;
  };
}

export interface DeploymentAnalysis {
  contracts: DeploymentCost[];
  totalGas: number;
  totalCost: { at50Gwei: string; at100Gwei: string; at200Gwei: string };
  largestContract: string;
  recommendations: string[];
}

// Pre-compiled regex patterns — hoisted to module scope to avoid re-compilation per call
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_LINE_COMMENT = /\/\/.*/g;
const RE_WHITESPACE = /\s+/g;
const RE_FUNCTION = /function\s+\w+/g;
const RE_STATE_VAR =
  /\b(uint|int|address|bool|bytes|mapping|string)\s+(?:public|private|internal)?\s*\w+/g;
const RE_EVENT = /event\s+\w+/g;
const RE_MODIFIER = /modifier\s+\w+/g;
const RE_CONSTRUCTOR = /constructor\s*\([^)]*\)\s*[^{]*{([^}]*)}/s;
const RE_STORAGE_WRITE = /\w+\s*=\s*[^;]+;/g;
const RE_EXTERNAL_CALL = /\.\w+\(/g;
const RE_LOOP = /\b(for|while)\s*\(/g;

export class DeploymentCostEstimator {
  private readonly CREATE_GAS = 32000;
  private readonly CREATE2_GAS = 32000;
  private readonly CODE_DEPOSIT_GAS_PER_BYTE = 200;
  private readonly GWEI_TO_ETH = 1e-9;

  // EIP-1167 minimal proxy costs
  private readonly CLONE_CREATION_GAS = 41000; // Much cheaper than full deployment
  private readonly CLONE_BYTECODE_SIZE = 45; // Minimal proxy is ~45 bytes

  /**
   * Estimate deployment cost from contract code (lightweight - no compilation)
   */
  public estimateContract(contractCode: string, contractName: string): DeploymentCost {
    const bytecodeSize = this.estimateBytecodeSize(contractCode);
    const initCodeSize = this.estimateInitCodeSize(contractCode);
    const constructorGas = this.estimateConstructorGas(contractCode);
    const deploymentGas = this.calculateDeploymentGas(bytecodeSize, initCodeSize, constructorGas);
    const costInEth = this.calculateCostInEth(deploymentGas.total);
    const optimizationImpact = this.estimateOptimizationImpact(bytecodeSize);
    const factoryPattern = this.detectFactoryPattern(contractCode, deploymentGas.total);

    return {
      contractName,
      bytecodeSize,
      initCodeSize,
      deploymentGas,
      costInEth,
      optimizationImpact,
      factoryPattern,
    };
  }

  /**
   * Estimate bytecode size from source (heuristic)
   */
  private estimateBytecodeSize(code: string): number {
    // Remove comments and whitespace
    const cleanCode = code
      .replace(RE_BLOCK_COMMENT, '')
      .replace(RE_LINE_COMMENT, '')
      .replace(RE_WHITESPACE, ' ')
      .trim();

    // Count significant code elements
    RE_FUNCTION.lastIndex = 0;
    RE_STATE_VAR.lastIndex = 0;
    RE_EVENT.lastIndex = 0;
    RE_MODIFIER.lastIndex = 0;
    const functions = (cleanCode.match(RE_FUNCTION) || []).length;
    const stateVars = (cleanCode.match(RE_STATE_VAR) || []).length;
    const events = (cleanCode.match(RE_EVENT) || []).length;
    const modifiers = (cleanCode.match(RE_MODIFIER) || []).length;

    // Rough heuristic: base + per-element costs
    let estimatedSize = 100; // Base contract overhead
    estimatedSize += functions * 150; // ~150 bytes per function
    estimatedSize += stateVars * 50; // Storage variable metadata
    estimatedSize += events * 30; // Event signatures
    estimatedSize += modifiers * 80; // Modifier code

    // Add code complexity factor
    const codeLength = cleanCode.length;
    estimatedSize += Math.floor(codeLength * 0.4); // ~40% conversion ratio

    return Math.min(estimatedSize, 24576); // Cap at 24KB limit
  }

  /**
   * Estimate init code size (constructor + creation)
   */
  private estimateInitCodeSize(code: string): number {
    const constructorMatch = code.match(RE_CONSTRUCTOR);

    if (!constructorMatch) {
      return 100; // Minimal init code
    }

    const constructorBody = constructorMatch[1];
    const constructorSize = Math.floor(constructorBody.length * 0.5);

    return 100 + constructorSize; // Base + constructor
  }

  /**
   * Estimate constructor execution gas
   */
  private estimateConstructorGas(code: string): number {
    const constructorMatch2 = code.match(RE_CONSTRUCTOR);

    if (!constructorMatch2) {
      return 21000; // Base transaction cost only
    }

    const constructorBody = constructorMatch2[1];
    let gas = 21000; // Base transaction cost

    // Count storage writes (expensive!)
    RE_STORAGE_WRITE.lastIndex = 0;
    const storageWrites = (constructorBody.match(RE_STORAGE_WRITE) || []).length;
    gas += storageWrites * 20000; // SSTORE ~20k gas

    // Count external calls
    RE_EXTERNAL_CALL.lastIndex = 0;
    const externalCalls = (constructorBody.match(RE_EXTERNAL_CALL) || []).length;
    gas += externalCalls * 10000; // External calls

    // Count loops (can be unbounded)
    RE_LOOP.lastIndex = 0;
    const loops = (constructorBody.match(RE_LOOP) || []).length;
    gas += loops * 50000; // Conservative estimate for loops

    return gas;
  }

  /**
   * Calculate total deployment gas
   */
  private calculateDeploymentGas(
    bytecodeSize: number,
    initCodeSize: number,
    constructorGas: number
  ): {
    creation: number;
    codeDeposit: number;
    constructor: number;
    total: number;
  } {
    const creation = this.CREATE_GAS;
    const codeDeposit = bytecodeSize * this.CODE_DEPOSIT_GAS_PER_BYTE;
    const total = creation + codeDeposit + constructorGas;

    return {
      creation,
      codeDeposit,
      constructor: constructorGas,
      total,
    };
  }

  /**
   * Calculate cost in ETH at different gas prices
   */
  private calculateCostInEth(totalGas: number): {
    at50Gwei: string;
    at100Gwei: string;
    at200Gwei: string;
  } {
    const at50 = (totalGas * 50 * this.GWEI_TO_ETH).toFixed(6);
    const at100 = (totalGas * 100 * this.GWEI_TO_ETH).toFixed(6);
    const at200 = (totalGas * 200 * this.GWEI_TO_ETH).toFixed(6);

    return {
      at50Gwei: `${at50} ETH`,
      at100Gwei: `${at100} ETH`,
      at200Gwei: `${at200} ETH`,
    };
  }

  /**
   * Estimate impact of optimizer
   */
  private estimateOptimizationImpact(bytecodeSize: number): {
    withOptimizer: number;
    withoutOptimizer: number;
  } {
    // Optimizer typically reduces bytecode by 10-30%
    const optimizedSize = Math.floor(bytecodeSize * 0.8); // 20% reduction
    const optimizedGas = optimizedSize * this.CODE_DEPOSIT_GAS_PER_BYTE;
    const unoptimizedGas = bytecodeSize * this.CODE_DEPOSIT_GAS_PER_BYTE;

    return {
      withOptimizer: optimizedGas,
      withoutOptimizer: unoptimizedGas,
    };
  }

  /**
   * Detect if factory pattern could be beneficial
   */
  private detectFactoryPattern(
    code: string,
    deploymentGas: number
  ): { clonePattern: boolean; estimatedSavings: number } | undefined {
    // Check if contract is likely to be deployed multiple times
    const hasFactory = code.includes('factory') || code.includes('Factory');
    const hasClone = code.includes('clone') || code.includes('Clones');

    if (hasFactory || hasClone || deploymentGas > 500000) {
      const cloneGas =
        this.CLONE_CREATION_GAS + this.CLONE_BYTECODE_SIZE * this.CODE_DEPOSIT_GAS_PER_BYTE;
      const savings = deploymentGas - cloneGas;

      return {
        clonePattern: hasClone,
        estimatedSavings: savings,
      };
    }

    return undefined;
  }

  /**
   * Analyze multiple contracts
   */
  public analyzeProject(contracts: Map<string, string>): DeploymentAnalysis {
    const contractCosts: DeploymentCost[] = [];
    let totalGas = 0;
    let largestContract = '';
    let largestSize = 0;

    contracts.forEach((code, name) => {
      const cost = this.estimateContract(code, name);
      contractCosts.push(cost);
      totalGas += cost.deploymentGas.total;

      if (cost.bytecodeSize > largestSize) {
        largestSize = cost.bytecodeSize;
        largestContract = name;
      }
    });

    const totalCost = this.calculateCostInEth(totalGas);
    const recommendations = this.generateRecommendations(contractCosts);

    return {
      contracts: contractCosts,
      totalGas,
      totalCost,
      largestContract,
      recommendations,
    };
  }

  /**
   * Generate optimization recommendations
   */
  private generateRecommendations(contracts: DeploymentCost[]): string[] {
    const recommendations: string[] = [];

    contracts.forEach((contract) => {
      // Large contract
      if (contract.bytecodeSize > 20000) {
        recommendations.push(
          `⚠️ ${contract.contractName}: Consider splitting into smaller contracts (${(contract.bytecodeSize / 1024).toFixed(1)}KB)`
        );
      }

      // Expensive constructor
      if (contract.deploymentGas.constructor > 1000000) {
        recommendations.push(
          `💰 ${contract.contractName}: Expensive constructor (${(contract.deploymentGas.constructor / 1e6).toFixed(2)}M gas). Consider initialization pattern.`
        );
      }

      // Factory pattern opportunity
      if (contract.factoryPattern && contract.factoryPattern.estimatedSavings > 100000) {
        recommendations.push(
          `🏭 ${contract.contractName}: Consider EIP-1167 minimal proxy pattern (save ~${(contract.factoryPattern.estimatedSavings / 1e6).toFixed(2)}M gas per clone)`
        );
      }

      // Optimizer impact
      const optimizerSavings =
        contract.optimizationImpact.withoutOptimizer - contract.optimizationImpact.withOptimizer;
      if (optimizerSavings > 50000) {
        recommendations.push(
          `⚡ ${contract.contractName}: Enable optimizer to save ~${(optimizerSavings / 1e3).toFixed(0)}k gas`
        );
      }
    });

    return recommendations;
  }

  /**
   * Generate markdown report
   */
  public generateReport(analysis: DeploymentAnalysis): string {
    let report = `# 💰 Deployment Cost Analysis\n\n`;

    // Summary
    report += `## 📊 Summary\n\n`;
    report += `- **Total Contracts**: ${analysis.contracts.length}\n`;
    report += `- **Total Deployment Gas**: ${analysis.totalGas.toLocaleString()}\n`;
    report += `- **Largest Contract**: ${analysis.largestContract}\n\n`;

    report += `### Estimated Deployment Costs\n\n`;
    report += `| Gas Price | Total Cost |\n`;
    report += `|-----------|------------|\n`;
    report += `| 50 Gwei | ${analysis.totalCost.at50Gwei} |\n`;
    report += `| 100 Gwei | ${analysis.totalCost.at100Gwei} |\n`;
    report += `| 200 Gwei | ${analysis.totalCost.at200Gwei} |\n\n`;

    // Individual contracts
    report += `## 📦 Contract Details\n\n`;
    analysis.contracts.forEach((contract) => {
      report += `### ${contract.contractName}\n\n`;
      report += `**Size**: ${contract.bytecodeSize.toLocaleString()} bytes (${(contract.bytecodeSize / 1024).toFixed(2)}KB)\n\n`;

      report += `**Deployment Gas Breakdown**:\n`;
      report += `- Contract Creation: ${contract.deploymentGas.creation.toLocaleString()} gas\n`;
      report += `- Code Deposit: ${contract.deploymentGas.codeDeposit.toLocaleString()} gas (${contract.bytecodeSize} bytes × 200)\n`;
      report += `- Constructor: ${contract.deploymentGas.constructor.toLocaleString()} gas\n`;
      report += `- **Total**: ${contract.deploymentGas.total.toLocaleString()} gas\n\n`;

      report += `**Deployment Cost**:\n`;
      report += `- At 50 Gwei: ${contract.costInEth.at50Gwei}\n`;
      report += `- At 100 Gwei: ${contract.costInEth.at100Gwei}\n`;
      report += `- At 200 Gwei: ${contract.costInEth.at200Gwei}\n\n`;

      if (contract.factoryPattern) {
        report += `**Factory Pattern Opportunity**:\n`;
        report += `- EIP-1167 Clone Savings: ~${contract.factoryPattern.estimatedSavings.toLocaleString()} gas per deployment\n`;
        report += `- Multiple deployments? Consider minimal proxy pattern\n\n`;
      }
    });

    // Recommendations
    if (analysis.recommendations.length > 0) {
      report += `## 🎯 Optimization Recommendations\n\n`;
      analysis.recommendations.forEach((rec) => {
        report += `${rec}\n\n`;
      });
    }

    return report;
  }

  /**
   * Create inline decorations for deployment cost
   */
  public createDeploymentDecorations(
    cost: DeploymentCost,
    document: vscode.TextDocument
  ): vscode.DecorationOptions[] {
    const decorations: vscode.DecorationOptions[] = [];
    const content = document.getText();

    // Annotate contract declaration
    const contractPattern = new RegExp(`contract\\s+${cost.contractName}`);
    const contractMatch = contractPattern.exec(content);

    if (contractMatch) {
      const position = document.positionAt(contractMatch.index + contractMatch[0].length);

      const decoration: vscode.DecorationOptions = {
        range: new vscode.Range(position, position),
        renderOptions: {
          after: {
            contentText: ` 💰 Deploy: ${(cost.deploymentGas.total / 1e6).toFixed(2)}M gas (~${cost.costInEth.at100Gwei})`,
            color: cost.bytecodeSize > 20000 ? '#ef4444' : '#4ade80',
            fontStyle: 'italic',
            margin: '0 0 0 1em',
          },
        },
        hoverMessage: new vscode.MarkdownString(
          `**Deployment Cost for ${cost.contractName}**\n\n` +
            `**Bytecode Size**: ${cost.bytecodeSize.toLocaleString()} bytes (${(cost.bytecodeSize / 1024).toFixed(2)}KB)\n\n` +
            `**Gas Breakdown**:\n` +
            `- Creation: ${cost.deploymentGas.creation.toLocaleString()}\n` +
            `- Code Deposit: ${cost.deploymentGas.codeDeposit.toLocaleString()}\n` +
            `- Constructor: ${cost.deploymentGas.constructor.toLocaleString()}\n` +
            `- **Total**: ${cost.deploymentGas.total.toLocaleString()} gas\n\n` +
            `**Cost Estimates**:\n` +
            `- 50 Gwei: ${cost.costInEth.at50Gwei}\n` +
            `- 100 Gwei: ${cost.costInEth.at100Gwei}\n` +
            `- 200 Gwei: ${cost.costInEth.at200Gwei}`
        ),
      };

      decorations.push(decoration);
    }

    // Annotate constructor
    const constructorPattern = /constructor\s*\([^)]*\)/;
    const constructorMatch = constructorPattern.exec(content);

    if (constructorMatch) {
      const position = document.positionAt(constructorMatch.index + constructorMatch[0].length);

      const decoration: vscode.DecorationOptions = {
        range: new vscode.Range(position, position),
        renderOptions: {
          after: {
            contentText: ` ⚡ ${(cost.deploymentGas.constructor / 1e3).toFixed(0)}k gas`,
            color: cost.deploymentGas.constructor > 500000 ? '#fb923c' : '#94a3b8',
            fontStyle: 'italic',
            margin: '0 0 0 1em',
          },
        },
        hoverMessage: new vscode.MarkdownString(
          `**Constructor Execution Cost**\n\n` +
            `${cost.deploymentGas.constructor.toLocaleString()} gas` +
            (cost.deploymentGas.constructor > 1000000
              ? '\n\n⚠️ **Warning**: Expensive constructor. Consider initialization pattern.'
              : '')
        ),
      };

      decorations.push(decoration);
    }

    return decorations;
  }
}
