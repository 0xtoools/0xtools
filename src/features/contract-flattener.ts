/**
 * Contract Flattener -- Solidity File Flattener
 *
 * Flattens Solidity files by resolving all imports into a single file.
 * Uses forge if available, otherwise falls back to a built-in resolver
 * that handles relative imports, lib/ (Foundry), node_modules/ (Hardhat),
 * and remappings from foundry.toml / remappings.txt.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlattenResult {
  success: boolean;
  output: string;
  error?: string;
  sourceFiles: string[];
  totalLines: number;
  licenseIdentifier?: string;
}

interface ImportStatement {
  path: string;
  line: number;
  statement: string;
}

interface Remapping {
  prefix: string;
  target: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_DEPTH = 64;

// Pre-compiled regexes for import extraction (called per file during flattening)
const IMPORT_REGEX =
  /import\s+(?:\{[^}]*\}\s+from\s+)?(?:\*\s+as\s+\w+\s+from\s+)?["']([^"']+)["']/;
const FILE_MARKER_REGEX = /\/\/\s*(?:File|file|SOURCE|source)[:\s]+(.+\.sol)/g;
const SPDX_REGEX = /\/\/\s*SPDX-License-Identifier:\s*(.+)/;
const FOUNDRY_TOML_REMAPPINGS_REGEX = /remappings\s*=\s*\[([\s\S]*?)\]/;
const REMAPPING_STRING_REGEX = /["']([^"']+)["']/g;

// ---------------------------------------------------------------------------
// ContractFlattener
// ---------------------------------------------------------------------------

export class ContractFlattener {
  /** Cache for remappings per project root. */
  private remappingCache: Map<string, Remapping[]>;

  constructor() {
    this.remappingCache = new Map();
  }

  // ─── Public API ───────────────────────────────────────────────────────

  /** Flatten using forge if available, otherwise use built-in resolver */
  async flatten(filePath: string, projectRoot?: string): Promise<FlattenResult> {
    // Try forge first
    try {
      const forgeResult = await this.flattenWithForge(filePath);
      if (forgeResult.success) {
        return forgeResult;
      }
    } catch {
      // forge not available or failed -- fall through to builtin
    }

    return this.flattenBuiltin(filePath, projectRoot);
  }

  /** Flatten using forge CLI */
  async flattenWithForge(filePath: string): Promise<FlattenResult> {
    return new Promise((resolve) => {
      const cwd = this.findProjectRoot(filePath) || path.dirname(filePath);

      execFile(
        'forge',
        ['flatten', filePath],
        { timeout: DEFAULT_TIMEOUT, maxBuffer: MAX_BUFFER, cwd },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              success: false,
              output: '',
              error: stderr?.trim() || err.message,
              sourceFiles: [],
              totalLines: 0,
            });
            return;
          }

          const output = stdout;
          const sourceFiles = this.extractSourceFilesFromFlattened(output, cwd);
          const licenseIdentifier = this.extractLicense(output);

          resolve({
            success: true,
            output,
            sourceFiles,
            totalLines: output.split('\n').length,
            licenseIdentifier,
          });
        }
      );
    });
  }

  /** Built-in flattener (for when forge is not available) */
  async flattenBuiltin(filePath: string, projectRoot?: string): Promise<FlattenResult> {
    const root = projectRoot || this.findProjectRoot(filePath) || path.dirname(filePath);
    const visited = new Set<string>();
    const sourceFiles: string[] = [];
    const parts: string[] = [];

    try {
      const absPath = path.resolve(filePath);
      const remappings = this.loadRemappings(root);

      this.collectSource(absPath, root, remappings, visited, sourceFiles, parts, 0);

      const rawOutput = parts.join('\n');
      const output = this.cleanFlattenedOutput(rawOutput);
      const licenseIdentifier = this.extractLicense(output);

      return {
        success: true,
        output,
        sourceFiles,
        totalLines: output.split('\n').length,
        licenseIdentifier,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        success: false,
        output: '',
        error: errMsg,
        sourceFiles,
        totalLines: 0,
      };
    }
  }

  /** Resolve import path to absolute file path */
  resolveImport(importPath: string, fromFile: string, projectRoot: string): string | null {
    const remappings = this.loadRemappings(projectRoot);
    return this.resolveImportPath(importPath, fromFile, projectRoot, remappings);
  }

  /** Extract import statements from source */
  extractImports(source: string): ImportStatement[] {
    const imports: ImportStatement[] = [];
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match various import forms:
      //   import "path";
      //   import { Foo } from "path";
      //   import * as Foo from "path";
      //   import "path" as Foo;
      const importMatch = IMPORT_REGEX.exec(line);

      if (importMatch) {
        imports.push({
          path: importMatch[1],
          line: i + 1,
          statement: line.trim(),
        });
      }
    }

    return imports;
  }

  /** Deduplicate SPDX license identifiers and pragma statements */
  cleanFlattenedOutput(source: string): string {
    const lines = source.split('\n');
    const result: string[] = [];
    let firstLicense: string | null = null;
    let firstPragma: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Capture first license and pragma; skip subsequent duplicates
      if (trimmed.startsWith('// SPDX-License-Identifier:')) {
        if (!firstLicense) {
          firstLicense = line;
        }
        continue;
      }

      if (trimmed.startsWith('pragma solidity')) {
        if (!firstPragma) {
          firstPragma = line;
        }
        continue;
      }

      // Skip import statements (they're inlined)
      if (trimmed.startsWith('import ') && (trimmed.includes('"') || trimmed.includes("'"))) {
        continue;
      }

      result.push(line);
    }

    // Prepend license and pragma at the top
    const header: string[] = [];
    if (firstLicense) {
      header.push(firstLicense);
    }
    if (firstPragma) {
      header.push(firstPragma);
    }
    if (header.length > 0) {
      header.push('');
    }

    return [...header, ...result].join('\n');
  }

  /** Generate report */
  generateReport(result: FlattenResult, filePath: string): string {
    const lines: string[] = [
      '## Flatten Report',
      '',
      `- **File:** \`${path.basename(filePath)}\``,
      `- **Status:** ${result.success ? 'Success' : 'Failed'}`,
      `- **Total Lines:** ${result.totalLines}`,
    ];

    if (result.licenseIdentifier) {
      lines.push(`- **License:** ${result.licenseIdentifier}`);
    }

    if (result.sourceFiles.length > 0) {
      lines.push('', '### Resolved Sources', '');
      for (const src of result.sourceFiles) {
        lines.push(`- \`${src}\``);
      }
    }

    if (result.error) {
      lines.push('', '### Error', '', '```', result.error, '```');
    }

    lines.push('');
    return lines.join('\n');
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Recursively collect and inline source files.
   */
  private collectSource(
    filePath: string,
    projectRoot: string,
    remappings: Remapping[],
    visited: Set<string>,
    sourceFiles: string[],
    parts: string[],
    depth: number
  ): void {
    if (depth > MAX_DEPTH) {
      throw new Error(`Maximum import depth (${MAX_DEPTH}) exceeded at ${filePath}`);
    }

    const resolved = path.resolve(filePath);
    if (visited.has(resolved)) {
      return;
    }
    visited.add(resolved);

    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }

    sourceFiles.push(resolved);
    const source = fs.readFileSync(resolved, 'utf-8');
    const imports = this.extractImports(source);

    // Process imports first (depth-first)
    for (const imp of imports) {
      const importResolved = this.resolveImportPath(imp.path, resolved, projectRoot, remappings);

      if (!importResolved) {
        // Add a comment noting the unresolved import
        parts.push(`// [flattener] Unresolved import: ${imp.path}`);
        continue;
      }

      this.collectSource(
        importResolved,
        projectRoot,
        remappings,
        visited,
        sourceFiles,
        parts,
        depth + 1
      );
    }

    // Add this file's contents (stripping import statements)
    const strippedLines: string[] = [];
    const sourceLines = source.split('\n');
    for (const line of sourceLines) {
      const trimmed = line.trim();
      // Skip import lines
      if (trimmed.startsWith('import ') && (trimmed.includes('"') || trimmed.includes("'"))) {
        continue;
      }
      strippedLines.push(line);
    }

    parts.push(`// ---- ${path.relative(projectRoot, resolved)} ----`);
    parts.push(strippedLines.join('\n'));
    parts.push('');
  }

  /**
   * Resolve an import path to an absolute file path.
   *
   * Resolution order:
   * 1. Apply remappings
   * 2. Relative to current file's directory
   * 3. From project root
   * 4. lib/ directory (Foundry)
   * 5. node_modules/ (Hardhat)
   */
  private resolveImportPath(
    importPath: string,
    fromFile: string,
    projectRoot: string,
    remappings: Remapping[]
  ): string | null {
    // 1. Apply remappings (already sorted by longest prefix in loadRemappings)
    for (const { prefix, target } of remappings) {
      if (importPath.startsWith(prefix)) {
        const remapped = importPath.replace(prefix, target);
        const candidate = path.resolve(projectRoot, remapped);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // 2. Relative to current file
    if (importPath.startsWith('.') || importPath.startsWith('/')) {
      const candidate = path.resolve(path.dirname(fromFile), importPath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // 3. From project root
    const fromRoot = path.resolve(projectRoot, importPath);
    if (fs.existsSync(fromRoot)) {
      return fromRoot;
    }

    // 4. lib/ directory (Foundry convention)
    // e.g. "forge-std/src/Test.sol" -> "lib/forge-std/src/Test.sol"
    const fromLib = path.resolve(projectRoot, 'lib', importPath);
    if (fs.existsSync(fromLib)) {
      return fromLib;
    }

    // Also try lib/<first-segment>/src/<rest>
    const segments = importPath.split('/');
    if (segments.length >= 2) {
      const libName = segments[0];
      const rest = segments.slice(1).join('/');

      // Direct lib path
      const libDirect = path.resolve(projectRoot, 'lib', libName, rest);
      if (fs.existsSync(libDirect)) {
        return libDirect;
      }

      // lib/<name>/src/<rest>
      const libSrc = path.resolve(projectRoot, 'lib', libName, 'src', rest);
      if (fs.existsSync(libSrc)) {
        return libSrc;
      }

      // lib/<name>/contracts/<rest>
      const libContracts = path.resolve(projectRoot, 'lib', libName, 'contracts', rest);
      if (fs.existsSync(libContracts)) {
        return libContracts;
      }
    }

    // 5. node_modules/ (Hardhat convention)
    const fromNodeModules = path.resolve(projectRoot, 'node_modules', importPath);
    if (fs.existsSync(fromNodeModules)) {
      return fromNodeModules;
    }

    // Also try parent directories for node_modules (monorepo support)
    let dir = projectRoot;
    for (let i = 0; i < 5; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      const parentNm = path.resolve(parent, 'node_modules', importPath);
      if (fs.existsSync(parentNm)) {
        return parentNm;
      }
      dir = parent;
    }

    return null;
  }

  /**
   * Load remappings from remappings.txt and foundry.toml.
   */
  private loadRemappings(projectRoot: string): Remapping[] {
    const cached = this.remappingCache.get(projectRoot);
    if (cached) {
      return cached;
    }

    const remappings: Remapping[] = [];

    // remappings.txt
    const remappingsTxt = path.join(projectRoot, 'remappings.txt');
    if (fs.existsSync(remappingsTxt)) {
      try {
        const content = fs.readFileSync(remappingsTxt, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            continue;
          }
          const parsed = this.parseRemappingLine(trimmed);
          if (parsed) {
            remappings.push(parsed);
          }
        }
      } catch {
        // ignore
      }
    }

    // foundry.toml
    const foundryToml = path.join(projectRoot, 'foundry.toml');
    if (fs.existsSync(foundryToml)) {
      try {
        const content = fs.readFileSync(foundryToml, 'utf-8');
        const match = FOUNDRY_TOML_REMAPPINGS_REGEX.exec(content);
        if (match) {
          REMAPPING_STRING_REGEX.lastIndex = 0;
          let m;
          while ((m = REMAPPING_STRING_REGEX.exec(match[1])) !== null) {
            const parsed = this.parseRemappingLine(m[1]);
            if (parsed && !remappings.some((r) => r.prefix === parsed.prefix)) {
              remappings.push(parsed);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // Sort once by longest prefix (used by resolveImportPath)
    remappings.sort((a, b) => b.prefix.length - a.prefix.length);

    this.remappingCache.set(projectRoot, remappings);
    return remappings;
  }

  /**
   * Parse a remapping line: [context:]prefix=target
   */
  private parseRemappingLine(line: string): Remapping | null {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      return null;
    }

    let left = line.substring(0, eqIndex);
    const target = line.substring(eqIndex + 1).trim();

    // Strip optional context
    const colonIndex = left.indexOf(':');
    if (colonIndex !== -1) {
      left = left.substring(colonIndex + 1);
    }

    const prefix = left.trim();
    if (!prefix || !target) {
      return null;
    }

    return { prefix, target };
  }

  /**
   * Extract source file paths mentioned in forge flatten output.
   * Forge flatten typically includes comments like "// File: path/to/file.sol"
   */
  private extractSourceFilesFromFlattened(output: string, cwd: string): string[] {
    const files: string[] = [];
    const seen = new Set<string>();

    // Forge flatten includes pragma lines from each file;
    // look for file marker comments
    FILE_MARKER_REGEX.lastIndex = 0;
    let match;
    while ((match = FILE_MARKER_REGEX.exec(output)) !== null) {
      const filePath = match[1].trim();
      if (!seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
    }

    // Also look for SPDX markers to count files if no explicit markers
    if (files.length === 0) {
      // Count unique pragma solidity lines as a proxy for number of source files
      const pragmaPattern = /pragma solidity/g;
      let count = 0;
      while (pragmaPattern.exec(output) !== null) {
        count++;
      }
      // At least the main file
      if (count === 0) {
        count = 1;
      }
    }

    return files;
  }

  /**
   * Extract SPDX license identifier from source.
   */
  private extractLicense(source: string): string | undefined {
    const match = SPDX_REGEX.exec(source);
    return match ? match[1].trim() : undefined;
  }

  /**
   * Find the Foundry project root (contains foundry.toml).
   */
  private findProjectRoot(filePath: string): string | null {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
        return dir;
      }
      // Also check for hardhat.config.*
      if (
        fs.existsSync(path.join(dir, 'hardhat.config.ts')) ||
        fs.existsSync(path.join(dir, 'hardhat.config.js'))
      ) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    return null;
  }
}
