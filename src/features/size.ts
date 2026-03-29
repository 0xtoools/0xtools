/**
 * Contract Size Analyzer - Check contract bytecode size against 24KB limit
 */

export interface ContractSizeInfo {
  name: string;
  estimatedSize: number;
  sizeInKB: number;
  limit: number;
  percentage: number;
  remaining: number;
  status: 'safe' | 'warning' | 'critical' | 'too-large';
  recommendations: string[];
}

// Pre-compiled regex patterns — hoisted to module scope to avoid re-compilation per call
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_LINE_COMMENT = /\/\/.*/g;
const RE_WHITESPACE = /\s+/g;
const RE_LONG_REQUIRE_MSG = /require.*,\s*"[^"]{50,}"/;

export class ContractSizeAnalyzer {
  private readonly SIZE_LIMIT = 24576; // 24KB in bytes
  private readonly WARNING_THRESHOLD = 0.9; // 90%
  private readonly CRITICAL_THRESHOLD = 0.95; // 95%

  /**
   * Estimate contract size based on code
   * Note: This is a rough estimation. Actual size would require compilation.
   */
  public estimateSize(contractCode: string): number {
    // Remove comments and whitespace
    const cleanCode = contractCode
      .replace(RE_BLOCK_COMMENT, '')
      .replace(RE_LINE_COMMENT, '')
      .replace(RE_WHITESPACE, ' ')
      .trim();

    // Rough estimation: ~60% of source code size converts to bytecode
    // This is very approximate and varies by optimizer settings
    const estimatedBytecode = Math.floor(cleanCode.length * 0.6);

    return estimatedBytecode;
  }

  /**
   * Analyze contract size and provide recommendations
   */
  public analyzeContract(contractName: string, contractCode: string): ContractSizeInfo {
    const estimatedSize = this.estimateSize(contractCode);
    const sizeInKB = estimatedSize / 1024;
    const percentage = (estimatedSize / this.SIZE_LIMIT) * 100;
    const remaining = this.SIZE_LIMIT - estimatedSize;

    let status: 'safe' | 'warning' | 'critical' | 'too-large';
    const recommendations: string[] = [];

    if (estimatedSize >= this.SIZE_LIMIT) {
      status = 'too-large';
      recommendations.push('Contract exceeds 24KB limit and cannot be deployed');
      recommendations.push('Consider splitting into multiple contracts');
      recommendations.push('Use libraries for shared code');
      recommendations.push('Remove unnecessary functions');
    } else if (percentage >= this.CRITICAL_THRESHOLD * 100) {
      status = 'critical';
      recommendations.push('Contract is dangerously close to size limit');
      recommendations.push('Enable optimizer with high runs');
      recommendations.push('Consider refactoring large functions');
      recommendations.push('Use external libraries instead of embedded code');
    } else if (percentage >= this.WARNING_THRESHOLD * 100) {
      status = 'warning';
      recommendations.push('Contract approaching size limit');
      recommendations.push('Monitor size during development');
      recommendations.push('Consider enabling optimizer');
    } else {
      status = 'safe';
      recommendations.push('Contract size is within acceptable limits');
    }

    // Add general optimization tips
    if (contractCode.includes('string')) {
      recommendations.push('Consider using bytes32 instead of string where possible');
    }
    if (RE_LONG_REQUIRE_MSG.test(contractCode)) {
      recommendations.push('Long error messages increase size - consider custom errors');
    }

    return {
      name: contractName,
      estimatedSize,
      sizeInKB: parseFloat(sizeInKB.toFixed(2)),
      limit: this.SIZE_LIMIT,
      percentage: parseFloat(percentage.toFixed(2)),
      remaining,
      status,
      recommendations,
    };
  }

  /**
   * Analyze all contracts in a project
   */
  public analyzeProject(contracts: Map<string, string>): Map<string, ContractSizeInfo> {
    const analysis = new Map<string, ContractSizeInfo>();

    contracts.forEach((code, name) => {
      analysis.set(name, this.analyzeContract(name, code));
    });

    return analysis;
  }

  /**
   * Generate size analysis report
   */
  public generateReport(analysis: Map<string, ContractSizeInfo>): string {
    let report = '# Contract Size Analysis\n\n';
    report += `**Deployment Size Limit**: 24KB (24,576 bytes)\n\n`;

    // Summary
    const contracts = Array.from(analysis.values());
    const tooLarge = contracts.filter((c) => c.status === 'too-large').length;
    const critical = contracts.filter((c) => c.status === 'critical').length;
    const warning = contracts.filter((c) => c.status === 'warning').length;
    const safe = contracts.filter((c) => c.status === 'safe').length;

    report += '## Summary\n\n';
    report += `- 🔴 **Too Large**: ${tooLarge}\n`;
    report += `- 🟠 **Critical**: ${critical}\n`;
    report += `- 🟡 **Warning**: ${warning}\n`;
    report += `- 🟢 **Safe**: ${safe}\n\n`;

    // Detailed table
    report += '## Contract Details\n\n';
    report += '| Contract | Size (KB) | Percentage | Status | Remaining |\n';
    report += '|----------|-----------|------------|--------|----------|\n';

    contracts.forEach((info) => {
      const statusEmoji = {
        'too-large': '🔴',
        critical: '🟠',
        warning: '🟡',
        safe: '🟢',
      }[info.status];

      const remainingKB = (info.remaining / 1024).toFixed(2);

      report += `| ${info.name} | ${info.sizeInKB} | ${info.percentage}% | ${statusEmoji} ${info.status} | ${remainingKB} KB |\n`;
    });

    report += '\n## Recommendations\n\n';

    // Group by status
    const problematic = contracts.filter(
      (c) => c.status === 'too-large' || c.status === 'critical' || c.status === 'warning'
    );

    if (problematic.length === 0) {
      report += '✅ All contracts are within safe size limits.\n\n';
      report += '**Best Practices:**\n';
      report += '- Continue to monitor contract size as you add features\n';
      report += '- Use the Solidity optimizer with appropriate runs setting\n';
      report += '- Consider using libraries for common functionality\n';
    } else {
      problematic.forEach((info) => {
        report += `### ${info.name} (${info.status.toUpperCase()})\n\n`;
        info.recommendations.forEach((rec) => {
          report += `- ${rec}\n`;
        });
        report += '\n';
      });

      report += '**General Optimization Strategies:**\n\n';
      report +=
        '1. **Enable Optimizer**: Use Solidity compiler with `--optimize --optimize-runs 200`\n';
      report += '2. **Use Libraries**: Move shared code to separate library contracts\n';
      report +=
        '3. **Custom Errors**: Replace require strings with custom errors (Solidity 0.8.4+)\n';
      report +=
        '4. **External Functions**: Mark functions as external instead of public when not called internally\n';
      report += '5. **Remove Dead Code**: Eliminate unused functions and variables\n';
      report += '6. **Short Error Messages**: Keep error messages under 32 characters\n';
      report += '7. **Split Contracts**: Divide functionality into multiple contracts\n';
      report += '8. **Use bytes32**: Replace string with bytes32 for fixed-length text\n';
    }

    return report;
  }

  /**
   * Generate size visualization (ASCII bar chart)
   */
  public generateVisualization(analysis: Map<string, ContractSizeInfo>): string {
    let viz = '\n## Size Visualization\n\n```\n';

    const contracts = Array.from(analysis.values());
    const maxNameLength = Math.max(...contracts.map((c) => c.name.length));

    contracts.forEach((info) => {
      const barLength = Math.floor((info.percentage / 100) * 50);
      const bar = '█'.repeat(barLength) + '░'.repeat(50 - barLength);
      const name = info.name.padEnd(maxNameLength);
      const percent = info.percentage.toFixed(1).padStart(5);

      viz += `${name} │${bar}│ ${percent}%\n`;
    });

    viz += '           │' + '─'.repeat(50) + '│\n';
    viz += '           0%                     50%                   100%\n';
    viz += '```\n';

    return viz;
  }
}
