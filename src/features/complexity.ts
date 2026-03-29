/**
 * Code Complexity Analyzer
 */

export interface ComplexityMetrics {
  cyclomaticComplexity: number;
  linesOfCode: number;
  cognitiveComplexity: number;
  maintainabilityIndex: number;
  rating: 'A' | 'B' | 'C' | 'D' | 'F';
  issues: string[];
}

// Pre-compiled regex patterns for cyclomatic complexity
const RE_IF = /\bif\s*\(/g;
const RE_ELSE_IF = /\belse\s+if\s*\(/g;
const RE_FOR = /\bfor\s*\(/g;
const RE_WHILE = /\bwhile\s*\(/g;
const RE_TERNARY = /\?/g;
const RE_LOGICAL_AND = /&&/g;
const RE_LOGICAL_OR = /\|\|/g;

// Pre-compiled regex patterns for cognitive complexity
const RE_NESTING_KEYWORD = /\b(if|for|while|switch)\s*\(/;
const RE_CLOSE_BRACE = /}/;
const RE_LOGICAL_OPERATORS = /&&|\|\|/;
const RE_THIS_CALL = /\bthis\.\w+\(/;

// Pre-compiled regex patterns for LOC counting
const RE_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const RE_LINE_COMMENT = /\/\/.*/g;

export class ComplexityAnalyzer {
  /**
   * Calculate cyclomatic complexity (McCabe complexity)
   */
  public calculateCyclomaticComplexity(code: string): number {
    let complexity = 1; // Base complexity

    // Decision points — reset lastIndex before each global regex use
    RE_IF.lastIndex = 0;
    RE_ELSE_IF.lastIndex = 0;
    RE_FOR.lastIndex = 0;
    RE_WHILE.lastIndex = 0;
    RE_TERNARY.lastIndex = 0;
    RE_LOGICAL_AND.lastIndex = 0;
    RE_LOGICAL_OR.lastIndex = 0;

    const ifStatements = (code.match(RE_IF) || []).length;
    const elseStatements = (code.match(RE_ELSE_IF) || []).length;
    const forLoops = (code.match(RE_FOR) || []).length;
    const whileLoops = (code.match(RE_WHILE) || []).length;
    const ternary = (code.match(RE_TERNARY) || []).length;
    const logicalAnd = (code.match(RE_LOGICAL_AND) || []).length;
    const logicalOr = (code.match(RE_LOGICAL_OR) || []).length;

    complexity +=
      ifStatements + elseStatements + forLoops + whileLoops + ternary + logicalAnd + logicalOr;

    return complexity;
  }

  /**
   * Calculate cognitive complexity (more human-oriented)
   */
  public calculateCognitiveComplexity(code: string): number {
    let complexity = 0;
    let nestingLevel = 0;

    // Simplified cognitive complexity calculation
    const lines = code.split('\n');

    lines.forEach((line) => {
      // Track nesting
      if (RE_NESTING_KEYWORD.test(line)) {
        complexity += 1 + nestingLevel;
        nestingLevel++;
      }

      if (RE_CLOSE_BRACE.test(line)) {
        nestingLevel = Math.max(0, nestingLevel - 1);
      }

      // Logical operators increase complexity
      if (RE_LOGICAL_OPERATORS.test(line)) {
        complexity += 1;
      }

      // Recursion
      if (RE_THIS_CALL.test(line)) {
        complexity += 1;
      }
    });

    return complexity;
  }

  /**
   * Count lines of code (excluding comments and blank lines)
   */
  public countLinesOfCode(code: string): number {
    // Remove comments
    const withoutComments = code
      .replace(RE_BLOCK_COMMENT, '') // Block comments
      .replace(RE_LINE_COMMENT, ''); // Line comments

    // Count non-empty lines
    return withoutComments.split('\n').filter((line) => line.trim().length > 0).length;
  }

  /**
   * Calculate maintainability index
   * Based on: MI = 171 - 5.2 * ln(V) - 0.23 * G - 16.2 * ln(L)
   * Where V = Halstead Volume, G = Cyclomatic Complexity, L = Lines of Code
   */
  public calculateMaintainabilityIndex(complexity: number, loc: number): number {
    // Simplified version without full Halstead metrics
    const halsteadVolume = loc * Math.log2(loc + 1); // Approximation
    const mi = Math.max(
      0,
      171 - 5.2 * Math.log(halsteadVolume) - 0.23 * complexity - 16.2 * Math.log(loc)
    );
    return Math.round(mi);
  }

  /**
   * Analyze function complexity
   */
  public analyzeFunction(functionCode: string, _functionName: string): ComplexityMetrics {
    const cyclomatic = this.calculateCyclomaticComplexity(functionCode);
    const cognitive = this.calculateCognitiveComplexity(functionCode);
    const loc = this.countLinesOfCode(functionCode);
    const maintainability = this.calculateMaintainabilityIndex(cyclomatic, loc);

    const issues: string[] = [];

    // Check for complexity issues
    if (cyclomatic > 10) {
      issues.push(`High cyclomatic complexity (${cyclomatic})`);
    }
    if (cognitive > 15) {
      issues.push(`High cognitive complexity (${cognitive})`);
    }
    if (loc > 100) {
      issues.push(`Function too long (${loc} lines)`);
    }
    if (maintainability < 65) {
      issues.push('Low maintainability index');
    }

    // Determine rating
    let rating: 'A' | 'B' | 'C' | 'D' | 'F';
    if (maintainability >= 85) {
      rating = 'A';
    } else if (maintainability >= 70) {
      rating = 'B';
    } else if (maintainability >= 55) {
      rating = 'C';
    } else if (maintainability >= 40) {
      rating = 'D';
    } else {
      rating = 'F';
    }

    return {
      cyclomaticComplexity: cyclomatic,
      linesOfCode: loc,
      cognitiveComplexity: cognitive,
      maintainabilityIndex: maintainability,
      rating,
      issues,
    };
  }

  /**
   * Analyze entire contract
   */
  public analyzeContract(
    contractCode: string,
    functions: any[]
  ): {
    functions: Map<string, ComplexityMetrics>;
    overall: ComplexityMetrics;
  } {
    const functionMetrics = new Map<string, ComplexityMetrics>();

    functions.forEach((func) => {
      const funcPattern = new RegExp(
        `function\\s+${func.name}\\s*\\([^)]*\\)[^{]*{([^}]*(?:{[^}]*}[^}]*)*)}`,
        's'
      );
      const match = contractCode.match(funcPattern);

      if (match && match[1]) {
        const metrics = this.analyzeFunction(match[1], func.name);
        functionMetrics.set(func.name, metrics);
      }
    });

    // Calculate overall metrics
    const overallLoc = this.countLinesOfCode(contractCode);
    const overallCyclomatic = this.calculateCyclomaticComplexity(contractCode);
    const overallCognitive = this.calculateCognitiveComplexity(contractCode);
    const overallMaintainability = this.calculateMaintainabilityIndex(
      overallCyclomatic,
      overallLoc
    );

    let rating: 'A' | 'B' | 'C' | 'D' | 'F';
    if (overallMaintainability >= 85) {
      rating = 'A';
    } else if (overallMaintainability >= 70) {
      rating = 'B';
    } else if (overallMaintainability >= 55) {
      rating = 'C';
    } else if (overallMaintainability >= 40) {
      rating = 'D';
    } else {
      rating = 'F';
    }

    return {
      functions: functionMetrics,
      overall: {
        cyclomaticComplexity: overallCyclomatic,
        linesOfCode: overallLoc,
        cognitiveComplexity: overallCognitive,
        maintainabilityIndex: overallMaintainability,
        rating,
        issues: [],
      },
    };
  }

  /**
   * Generate complexity report
   */
  public generateReport(
    contractName: string,
    analysis: {
      functions: Map<string, ComplexityMetrics>;
      overall: ComplexityMetrics;
    }
  ): string {
    let report = `# Complexity Analysis: ${contractName}\n\n`;

    report += '## Overall Metrics\n\n';
    report += `- **Lines of Code**: ${analysis.overall.linesOfCode}\n`;
    report += `- **Cyclomatic Complexity**: ${analysis.overall.cyclomaticComplexity}\n`;
    report += `- **Cognitive Complexity**: ${analysis.overall.cognitiveComplexity}\n`;
    report += `- **Maintainability Index**: ${analysis.overall.maintainabilityIndex} (${analysis.overall.rating})\n\n`;

    report += '## Function Analysis\n\n';
    report += '| Function | LOC | Cyclomatic | Cognitive | Maintainability | Rating | Issues |\n';
    report += '|----------|-----|------------|-----------|-----------------|--------|--------|\n';

    analysis.functions.forEach((metrics, funcName) => {
      const issues = metrics.issues.length > 0 ? metrics.issues.join('; ') : 'None';
      report += `| ${funcName} | ${metrics.linesOfCode} | ${metrics.cyclomaticComplexity} | ${metrics.cognitiveComplexity} | ${metrics.maintainabilityIndex} | ${metrics.rating} | ${issues} |\n`;
    });

    report += '\n## Recommendations\n\n';
    const problematicFunctions = Array.from(analysis.functions.entries()).filter(
      ([_, metrics]) => metrics.issues.length > 0
    );

    if (problematicFunctions.length === 0) {
      report += '✅ All functions have acceptable complexity metrics.\n';
    } else {
      report += '⚠️ The following functions should be refactored:\n\n';
      problematicFunctions.forEach(([name, metrics]) => {
        report += `- **${name}**: ${metrics.issues.join(', ')}\n`;
      });
    }

    return report;
  }
}
