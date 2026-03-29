/**
 * Slither Integration — Static analysis via Slither CLI
 *
 * Runs slither on a Solidity file/project, parses JSON output,
 * maps findings to VS Code diagnostics, and generates markdown reports.
 *
 * Slither is an optional external dependency — graceful degradation
 * when not installed.
 */

import * as path from 'path';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlitherFinding {
  check: string;
  description: string;
  impact: 'High' | 'Medium' | 'Low' | 'Informational' | 'Optimization';
  confidence: 'High' | 'Medium' | 'Low';
  elements: Array<{
    type: string;
    name: string;
    source_mapping?: {
      filename_relative: string;
      lines: number[];
    };
  }>;
}

export interface SlitherDiagnostic {
  file: string;
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Raw Slither JSON output shape
// ---------------------------------------------------------------------------

interface SlitherJsonOutput {
  success: boolean;
  error: string | null;
  results?: {
    detectors?: Array<{
      check: string;
      description: string;
      impact: string;
      confidence: string;
      elements: Array<{
        type: string;
        name: string;
        source_mapping?: {
          filename_relative?: string;
          filename_absolute?: string;
          lines?: number[];
          starting_column?: number;
          ending_column?: number;
        };
      }>;
    }>;
  };
}

// ---------------------------------------------------------------------------
// SlitherIntegration
// ---------------------------------------------------------------------------

export class SlitherIntegration {
  private slitherPath: string;

  constructor(slitherPath?: string) {
    this.slitherPath = slitherPath || 'slither';
  }

  /**
   * Check if slither is installed and accessible.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.slitherPath, ['--version'], { timeout: 10_000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Run slither analysis on a file or directory.
   *
   * @param targetPath - Path to a .sol file or project directory
   * @returns Array of SlitherFinding objects
   */
  async analyze(targetPath: string): Promise<SlitherFinding[]> {
    return new Promise((resolve, reject) => {
      // Build args: output JSON to stdout, skip compilation if possible
      const args = [targetPath, '--json', '-'];

      execFile(
        this.slitherPath,
        args,
        {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024, // 10MB — slither can be verbose
          cwd: this.findProjectRoot(targetPath),
        },
        (err, stdout, _stderr) => {
          // Slither exits with non-zero when it finds issues — that's normal.
          // We only reject if there's no usable output at all.
          const output = stdout?.trim();
          if (!output) {
            if (err) {
              reject(new Error(`Slither failed: ${err.message}`));
            } else {
              resolve([]);
            }
            return;
          }

          try {
            const parsed: SlitherJsonOutput = JSON.parse(output);
            const findings = this.parseFindings(parsed);
            resolve(findings);
          } catch (parseErr) {
            // Sometimes slither prints extra text before/after JSON.
            // Try to extract JSON from the output.
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
              try {
                const extracted = output.substring(jsonStart, jsonEnd + 1);
                const parsed: SlitherJsonOutput = JSON.parse(extracted);
                const findings = this.parseFindings(parsed);
                resolve(findings);
                return;
              } catch {
                // Fall through to reject
              }
            }
            reject(new Error(`Failed to parse slither output: ${parseErr}`));
          }
        }
      );
    });
  }

  /**
   * Convert findings to VS Code-compatible diagnostics.
   */
  toDiagnostics(findings: SlitherFinding[]): SlitherDiagnostic[] {
    const diagnostics: SlitherDiagnostic[] = [];

    for (const finding of findings) {
      const severity = this.mapImpactToSeverity(finding.impact);

      // Create a diagnostic for each element that has source mapping
      const elementsWithSource = finding.elements.filter(
        (el) => el.source_mapping && el.source_mapping.lines && el.source_mapping.lines.length > 0
      );

      if (elementsWithSource.length === 0) {
        // No source mapping — create a generic diagnostic at line 1
        diagnostics.push({
          file: '',
          line: 1,
          severity,
          message: `[${finding.check}] ${this.cleanDescription(finding.description)} (${finding.impact} impact, ${finding.confidence} confidence)`,
          code: `slither-${finding.check}`,
        });
        continue;
      }

      // Deduplicate: one diagnostic per unique file+line combination for this finding
      const seen = new Set<string>();
      for (const element of elementsWithSource) {
        const file = element.source_mapping!.filename_relative || '';
        const line = element.source_mapping!.lines[0] || 1;
        const key = `${file}:${line}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        diagnostics.push({
          file,
          line,
          severity,
          message: `[${finding.check}] ${this.cleanDescription(finding.description)} (${finding.impact} impact, ${finding.confidence} confidence)`,
          code: `slither-${finding.check}`,
        });
      }
    }

    return diagnostics;
  }

  /**
   * Generate a markdown report from findings.
   */
  generateReport(findings: SlitherFinding[]): string {
    const lines: string[] = [
      '# Slither Static Analysis Report',
      '',
      `**Total findings:** ${findings.length}`,
      '',
    ];

    if (findings.length === 0) {
      lines.push('No issues found.');
      return lines.join('\n');
    }

    // Summary table
    const highCount = findings.filter((f) => f.impact === 'High').length;
    const mediumCount = findings.filter((f) => f.impact === 'Medium').length;
    const lowCount = findings.filter((f) => f.impact === 'Low').length;
    const infoCount = findings.filter((f) => f.impact === 'Informational').length;
    const optCount = findings.filter((f) => f.impact === 'Optimization').length;

    lines.push('## Summary');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    if (highCount > 0) {
      lines.push(`| High | ${highCount} |`);
    }
    if (mediumCount > 0) {
      lines.push(`| Medium | ${mediumCount} |`);
    }
    if (lowCount > 0) {
      lines.push(`| Low | ${lowCount} |`);
    }
    if (infoCount > 0) {
      lines.push(`| Informational | ${infoCount} |`);
    }
    if (optCount > 0) {
      lines.push(`| Optimization | ${optCount} |`);
    }
    lines.push('');

    // Group by impact
    const groups: Array<{
      label: string;
      impact: SlitherFinding['impact'];
      icon: string;
    }> = [
      { label: 'High Impact', impact: 'High', icon: '[!]' },
      { label: 'Medium Impact', impact: 'Medium', icon: '[*]' },
      { label: 'Low Impact', impact: 'Low', icon: '[-]' },
      { label: 'Informational', impact: 'Informational', icon: '[i]' },
      { label: 'Optimization', impact: 'Optimization', icon: '[o]' },
    ];

    for (const group of groups) {
      const groupFindings = findings.filter((f) => f.impact === group.impact);
      if (groupFindings.length === 0) {
        continue;
      }

      lines.push(`## ${group.icon} ${group.label} (${groupFindings.length})`);
      lines.push('');

      for (const finding of groupFindings) {
        lines.push(`### ${finding.check}`);
        lines.push('');
        lines.push(`**Confidence:** ${finding.confidence}`);
        lines.push('');
        lines.push(this.cleanDescription(finding.description));
        lines.push('');

        // List affected elements
        const namedElements = finding.elements.filter((el) => el.name);
        if (namedElements.length > 0) {
          lines.push('**Affected elements:**');
          for (const el of namedElements) {
            const loc = el.source_mapping
              ? ` (${el.source_mapping.filename_relative}:${el.source_mapping.lines[0] || '?'})`
              : '';
            lines.push(`- \`${el.name}\` (${el.type})${loc}`);
          }
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      }
    }

    lines.push('');
    lines.push('*Report generated by 0xTools Slither integration*');

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Parse the raw slither JSON output into SlitherFinding objects.
   */
  private parseFindings(output: SlitherJsonOutput): SlitherFinding[] {
    if (!output.results || !output.results.detectors) {
      return [];
    }

    return output.results.detectors.map((detector) => ({
      check: detector.check || 'unknown',
      description: detector.description || '',
      impact: this.normalizeImpact(detector.impact),
      confidence: this.normalizeConfidence(detector.confidence),
      elements: (detector.elements || []).map((el) => ({
        type: el.type || 'unknown',
        name: el.name || '',
        source_mapping: el.source_mapping
          ? {
              filename_relative:
                el.source_mapping.filename_relative || el.source_mapping.filename_absolute || '',
              lines: el.source_mapping.lines || [],
            }
          : undefined,
      })),
    }));
  }

  /**
   * Normalize impact string to typed enum value.
   */
  private normalizeImpact(impact: string): SlitherFinding['impact'] {
    const normalized = (impact || '').toLowerCase();
    if (normalized === 'high') {
      return 'High';
    }
    if (normalized === 'medium') {
      return 'Medium';
    }
    if (normalized === 'low') {
      return 'Low';
    }
    if (normalized === 'optimization') {
      return 'Optimization';
    }
    return 'Informational';
  }

  /**
   * Normalize confidence string to typed enum value.
   */
  private normalizeConfidence(confidence: string): SlitherFinding['confidence'] {
    const normalized = (confidence || '').toLowerCase();
    if (normalized === 'high') {
      return 'High';
    }
    if (normalized === 'medium') {
      return 'Medium';
    }
    return 'Low';
  }

  /**
   * Map slither impact level to VS Code diagnostic severity.
   */
  private mapImpactToSeverity(impact: SlitherFinding['impact']): SlitherDiagnostic['severity'] {
    switch (impact) {
      case 'High':
        return 'error';
      case 'Medium':
        return 'warning';
      case 'Low':
        return 'info';
      case 'Informational':
      case 'Optimization':
        return 'hint';
    }
  }

  /**
   * Clean up slither description text for display.
   * Removes ANSI escape codes and excessive whitespace.
   */
  private cleanDescription(description: string): string {
    return (
      description
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, '') // Strip ANSI codes
        .replace(/\t/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim()
    );
  }

  /**
   * Find the project root directory (containing foundry.toml, hardhat.config, or package.json).
   */
  private findProjectRoot(filePath: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    let dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    const markers = ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts', 'package.json'];

    while (dir !== path.dirname(dir)) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(dir, marker))) {
          return dir;
        }
      }
      dir = path.dirname(dir);
    }

    // Fallback to the file's directory
    return fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
  }
}
