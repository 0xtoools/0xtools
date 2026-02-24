/**
 * Gas Estimation - Estimate gas costs for functions using solc compiler
 */

import { keccak256 } from 'js-sha3';
import { SolcManager, compileWithGasAnalysis, GasInfo } from './SolcManager';
import { FunctionSignature } from '../types';

export interface GasEstimate {
  function: string;
  signature: string;
  selector: string;
  estimatedGas: {
    min: number | 'infinite';
    max: number | 'infinite';
    average: number | 'infinite';
  };
  complexity: 'low' | 'medium' | 'high' | 'very-high' | 'unbounded';
  factors: string[];
  warning?: string;
  source: 'solc' | 'heuristic';
}

export class GasEstimator {
  private readonly BASE_COST = 21000;
  private readonly FUNCTION_CALL = 2300;
  private readonly STORAGE_READ = 800;
  private readonly STORAGE_WRITE = 20000;
  private readonly LOOP_ITERATION = 500;
  private readonly EXTERNAL_CALL = 2600;

  private useSolc: boolean;

  constructor(useSolc = true, _optimizerRuns = 200) {
    this.useSolc = useSolc;
  }

  public isSolcAvailable(): boolean {
    return this.useSolc;
  }

  public getSolcVersion(): string | null {
    try {
      return SolcManager.getBundledVersion();
    } catch {
      return null;
    }
  }

  public async estimateGasWithSolc(
    filePath: string,
    signature: string,
    content?: string
  ): Promise<GasEstimate | null> {
    if (!this.useSolc) {
      return null;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const source = content || require('fs').readFileSync(filePath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fileName = require('path').basename(filePath);
      const result = await compileWithGasAnalysis(source, fileName);

      if (!result.success || result.gasInfo.length === 0) {
        return null;
      }

      // Find matching gas info by function name
      const functionName = signature.split('(')[0];
      // Try exact name match
      const gasInfoMatch = result.gasInfo.find((g) => {
        const sig = `${g.name}(`;
        return signature.startsWith(sig) || g.name === functionName;
      });

      if (!gasInfoMatch) {
        return null;
      }

      const hash = keccak256(signature);
      const selector = '0x' + hash.substring(0, 8);

      const gas = gasInfoMatch.gas;
      const numericGas = gas === 'infinite' ? Infinity : gas;
      const average: number | 'infinite' = gas === 'infinite' ? 'infinite' : gas;

      return {
        function: signature,
        signature,
        selector,
        estimatedGas: {
          min: gas,
          max: gas,
          average,
        },
        complexity: classifyComplexity(numericGas),
        factors: inferFactors(signature, numericGas),
        warning: generateWarning(numericGas),
        source: 'solc',
      };
    } catch (error) {
      console.error('Error getting solc gas estimate:', error);
      return null;
    }
  }

  public estimateGasHeuristic(functionCode: string, signature: string): GasEstimate {
    const factors: string[] = [];
    let minGas = this.FUNCTION_CALL;
    let maxGas = this.FUNCTION_CALL;

    const storageReads = (functionCode.match(/\b\w+\s*\[/g) || []).length;
    const storageWrites = (functionCode.match(/\b\w+\s*\[.*?\]\s*=/g) || []).length;

    if (storageReads > 0) {
      minGas += storageReads * this.STORAGE_READ;
      maxGas += storageReads * this.STORAGE_READ;
      factors.push(`${storageReads} storage reads`);
    }

    if (storageWrites > 0) {
      minGas += storageWrites * this.STORAGE_WRITE;
      maxGas += storageWrites * this.STORAGE_WRITE;
      factors.push(`${storageWrites} storage writes`);
    }

    const loops = (functionCode.match(/\b(for|while)\s*\(/g) || []).length;
    if (loops > 0) {
      minGas += loops * this.LOOP_ITERATION * 10;
      maxGas += loops * this.LOOP_ITERATION * 1000;
      factors.push(`${loops} loop(s) - unbounded gas`);
    }

    const externalCalls = (functionCode.match(/\.\w+\(/g) || []).length;
    if (externalCalls > 0) {
      minGas += externalCalls * this.EXTERNAL_CALL;
      maxGas += externalCalls * this.EXTERNAL_CALL * 10;
      factors.push(`${externalCalls} external call(s)`);
    }

    if (functionCode.includes('require') || functionCode.includes('revert')) {
      factors.push('Conditional logic');
    }

    if (functionCode.includes('emit')) {
      const events = (functionCode.match(/emit\s+\w+/g) || []).length;
      minGas += events * 375;
      maxGas += events * 2000;
      factors.push(`${events} event emission(s)`);
    }

    let complexity: 'low' | 'medium' | 'high' | 'very-high';
    const avgGas = (minGas + maxGas) / 2;

    if (avgGas < 50000) {
      complexity = 'low';
    } else if (avgGas < 150000) {
      complexity = 'medium';
    } else if (avgGas < 500000) {
      complexity = 'high';
    } else {
      complexity = 'very-high';
    }

    let warning: string | undefined;
    if (loops > 0) {
      warning = 'Contains unbounded loops - gas cost depends on input size';
    } else if (avgGas > 500000) {
      warning = 'High gas cost - consider optimization';
    }

    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);

    return {
      function: signature,
      signature,
      selector,
      estimatedGas: {
        min: minGas,
        max: maxGas,
        average: Math.round(avgGas),
      },
      complexity,
      factors: factors.length > 0 ? factors : ['Simple computation'],
      warning,
      source: 'heuristic',
    };
  }

  public async estimateGas(
    functionCode: string,
    signature: string,
    filePath?: string,
    fileContent?: string
  ): Promise<GasEstimate> {
    if (!this.useSolc || !filePath) {
      // Solc unavailable — fall back to heuristic if we have function code
      if (functionCode) {
        return this.estimateGasHeuristic(functionCode, signature);
      }
      const hash = keccak256(signature);
      const selector = '0x' + hash.substring(0, 8);
      return {
        function: signature,
        signature,
        selector,
        estimatedGas: { min: 0, max: 0, average: 0 },
        complexity: 'low',
        factors: ['Solc unavailable - install solc for accurate estimation'],
        warning: 'Install solc for gas estimation',
        source: 'heuristic',
      };
    }

    const solcEstimate = await this.estimateGasWithSolc(filePath, signature, fileContent);
    if (solcEstimate) {
      return solcEstimate;
    }

    // Solc compilation failed — fall back to heuristic if we have function code
    if (functionCode) {
      const heuristic = this.estimateGasHeuristic(functionCode, signature);
      heuristic.factors.unshift('Solc compilation failed - using heuristic');
      return heuristic;
    }

    const hash = keccak256(signature);
    const selector = '0x' + hash.substring(0, 8);
    return {
      function: signature,
      signature,
      selector,
      estimatedGas: { min: 0, max: 0, average: 0 },
      complexity: 'low',
      factors: ['Compilation failed - no function body available for heuristic'],
      warning: 'Could not compile contract - check for errors',
      source: 'heuristic',
    };
  }

  public estimateGasSync(functionCode: string, signature: string): GasEstimate {
    return this.estimateGasHeuristic(functionCode, signature);
  }

  public async estimateContractGas(
    contractCode: string,
    functions: FunctionSignature[],
    filePath?: string
  ): Promise<GasEstimate[]> {
    const estimates: GasEstimate[] = [];

    if (this.useSolc && filePath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fileName = require('path').basename(filePath);
        const result = await compileWithGasAnalysis(contractCode, fileName);

        if (result.success && result.gasInfo.length > 0) {
          for (const func of functions) {
            const signature = func.signature;
            const funcName = func.name;

            // Find matching gas info
            const gasInfoMatch = result.gasInfo.find(
              (g) => g.name === funcName || g.name === signature.split('(')[0]
            );

            if (gasInfoMatch) {
              const hash = keccak256(signature);
              const selector = '0x' + hash.substring(0, 8);
              const gas = gasInfoMatch.gas;
              const numericGas = gas === 'infinite' ? Infinity : gas;

              estimates.push({
                function: signature,
                signature,
                selector,
                estimatedGas: {
                  min: gas,
                  max: gas,
                  average: gas,
                },
                complexity: classifyComplexity(numericGas),
                factors: inferFactors(signature, numericGas),
                warning: generateWarning(numericGas),
                source: 'solc',
              });
            }
          }
        }
      } catch (error) {
        console.error('Error getting solc estimates for contract:', error);
      }
    }

    // Fall back to heuristic for functions that solc couldn't analyze
    for (const func of functions) {
      if (!estimates.find((e) => e.signature === func.signature)) {
        const funcBody = this.extractFunctionBody(contractCode, func.name);
        if (funcBody) {
          const heuristic = this.estimateGasHeuristic(funcBody, func.signature);
          heuristic.factors.unshift('Solc could not analyze - using heuristic');
          estimates.push(heuristic);
        } else {
          const hash = keccak256(func.signature);
          const selector = '0x' + hash.substring(0, 8);
          estimates.push({
            function: func.signature,
            signature: func.signature,
            selector,
            estimatedGas: { min: 0, max: 0, average: 0 },
            complexity: 'low',
            factors: ['Solc could not analyze - function body not extractable'],
            source: 'heuristic',
          });
        }
      }
    }

    return estimates;
  }

  public generateGasReport(estimates: GasEstimate[]): string {
    let report = '# Gas Estimation Report\n\n';

    const solcCount = estimates.filter((e) => e.source === 'solc').length;
    const heuristicCount = estimates.filter((e) => e.source === 'heuristic').length;

    if (solcCount > 0) {
      const version = this.getSolcVersion();
      report += `**Compiler**: Solidity ${version || 'unknown'} (${solcCount} functions)\n`;
    }
    if (heuristicCount > 0) {
      report += `**Heuristic**: ${heuristicCount} functions\n`;
    }
    report += '\n';

    report +=
      '| Function | Selector | Min Gas | Max Gas | Avg Gas | Complexity | Source | Notes |\n';
    report +=
      '|----------|----------|---------|---------|---------|------------|--------|-------|\n';

    estimates.forEach((est) => {
      const warning = est.warning ? ` ${est.warning}` : '';
      const minGas =
        est.estimatedGas.min === 'infinite' ? 'inf' : est.estimatedGas.min.toLocaleString();
      const maxGas =
        est.estimatedGas.max === 'infinite' ? 'inf' : est.estimatedGas.max.toLocaleString();
      const avgGas =
        est.estimatedGas.average === 'infinite' ? 'inf' : est.estimatedGas.average.toLocaleString();

      report += `| ${est.function} | \`${est.selector}\` | ${minGas} | ${maxGas} | ${avgGas} | ${est.complexity} | ${est.source} | ${est.factors.join(', ')}${warning} |\n`;
    });

    report += '\n## Summary\n\n';
    report += `- **Total Functions**: ${estimates.length}\n`;

    const finiteEstimates = estimates.filter((e) => e.estimatedGas.average !== 'infinite');
    if (finiteEstimates.length > 0) {
      const totalAvg = finiteEstimates.reduce(
        (sum, est) => sum + Number(est.estimatedGas.average),
        0
      );
      report += `- **Average Gas per Function**: ${Math.round(totalAvg / finiteEstimates.length).toLocaleString()}\n`;
    }

    report += `- **High Complexity Functions**: ${estimates.filter((e) => e.complexity === 'high' || e.complexity === 'very-high' || e.complexity === 'unbounded').length}\n`;
    report += `- **Unbounded Functions**: ${estimates.filter((e) => e.complexity === 'unbounded').length}\n`;

    return report;
  }

  /**
   * Extract function body from contract source code by name.
   * Uses brace-matching to find the full function body.
   */
  private extractFunctionBody(contractCode: string, functionName: string): string | null {
    const pattern =
      functionName === 'constructor'
        ? /constructor\s*\([^)]*\)[^{]*\{/s
        : new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)[^{]*\\{`, 's');

    const match = pattern.exec(contractCode);
    if (!match) {
      return null;
    }

    const startIndex = match.index;
    const braceStart = startIndex + match[0].length - 1; // position of '{'
    let braceCount = 1;
    let i = braceStart + 1;

    while (i < contractCode.length && braceCount > 0) {
      if (contractCode[i] === '{') {
        braceCount++;
      } else if (contractCode[i] === '}') {
        braceCount--;
      }
      i++;
    }

    return contractCode.substring(startIndex, i);
  }

  public triggerCompilerUpgrade(_source: string, _onUpgrade?: (version: string) => void): void {
    // Version management is now handled by SolcManager automatically
  }
}

// --- Standalone helper functions (previously on SolcIntegration) ---

function classifyComplexity(gas: number): 'low' | 'medium' | 'high' | 'very-high' | 'unbounded' {
  if (!isFinite(gas)) {
    return 'unbounded';
  }
  if (gas < 50_000) {
    return 'low';
  }
  if (gas < 150_000) {
    return 'medium';
  }
  if (gas < 500_000) {
    return 'high';
  }
  return 'very-high';
}

function inferFactors(signature: string, gas: number): string[] {
  const factors: string[] = [];

  if (!isFinite(gas)) {
    factors.push('Unbounded execution (loops or recursion)');
  }

  if (isFinite(gas) && gas > 100_000) {
    factors.push('Expensive operations (storage, external calls, or computation)');
  }

  if (isFinite(gas) && gas > 20_000 && gas < 45_000) {
    factors.push('Likely contains storage writes');
  }

  if (signature.includes('constructor')) {
    factors.push('Contract initialization');
  }

  if (factors.length === 0) {
    factors.push('Standard EVM execution');
  }

  return factors;
}

function generateWarning(gas: number): string | undefined {
  if (!isFinite(gas)) {
    return 'Unbounded gas cost - contains loops or recursion';
  }
  if (gas > 500_000) {
    return 'Very high gas cost - may fail on mainnet or be expensive';
  }
  if (gas > 300_000) {
    return 'High gas cost - consider optimization';
  }
  return undefined;
}
