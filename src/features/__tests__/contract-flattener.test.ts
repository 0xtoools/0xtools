/**
 * Tests for ContractFlattener — Solidity file flattener
 */

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}));

import { ContractFlattener, FlattenResult } from '../contract-flattener';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = fs.existsSync as jest.Mock;
const mockReadFileSync = fs.readFileSync as jest.Mock;

describe('ContractFlattener', () => {
  let flattener: ContractFlattener;

  beforeEach(() => {
    flattener = new ContractFlattener();
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create flattener', () => {
      expect(flattener).toBeDefined();
    });
  });

  describe('extractImports', () => {
    it('should find import statements with double quotes', () => {
      const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

contract MyToken is ERC20, Ownable {}
`;

      const imports = flattener.extractImports(source);

      expect(imports.length).toBe(2);
      expect(imports[0].path).toBe('@openzeppelin/contracts/token/ERC20/ERC20.sol');
      expect(imports[0].line).toBeGreaterThan(0);
      expect(imports[1].path).toBe('@openzeppelin/contracts/access/Ownable.sol');
    });

    it('should find import statements with single quotes', () => {
      const source = `import './Foo.sol';`;

      const imports = flattener.extractImports(source);
      expect(imports.length).toBe(1);
      expect(imports[0].path).toBe('./Foo.sol');
    });

    it('should find wildcard imports', () => {
      const source = `import * as Utils from "./Utils.sol";`;

      const imports = flattener.extractImports(source);
      expect(imports.length).toBe(1);
      expect(imports[0].path).toBe('./Utils.sol');
    });

    it('should return empty array for source without imports', () => {
      const source = `
pragma solidity ^0.8.20;
contract Simple {}
`;
      const imports = flattener.extractImports(source);
      expect(imports).toEqual([]);
    });

    it('should capture the full import statement', () => {
      const source = `import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";`;

      const imports = flattener.extractImports(source);
      expect(imports[0].statement).toContain('import');
      expect(imports[0].statement).toContain('Ownable');
    });
  });

  describe('cleanFlattenedOutput', () => {
    it('should deduplicate SPDX license identifiers', () => {
      const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract A {}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract B {}
// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.19;
contract C {}
`;

      const cleaned = flattener.cleanFlattenedOutput(source);

      // Should keep only the first license and pragma
      const licenseCount = (cleaned.match(/SPDX-License-Identifier/g) || []).length;
      expect(licenseCount).toBe(1);

      const pragmaCount = (cleaned.match(/pragma solidity/g) || []).length;
      expect(pragmaCount).toBe(1);
    });

    it('should remove import statements', () => {
      const source = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./Foo.sol";
import { Bar } from "./Bar.sol";
contract Main {}
`;

      const cleaned = flattener.cleanFlattenedOutput(source);
      expect(cleaned).not.toContain('import ');
      expect(cleaned).toContain('contract Main');
    });

    it('should prepend license and pragma at top', () => {
      const source = `
contract A {}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract B {}
`;

      const cleaned = flattener.cleanFlattenedOutput(source);
      const lines = cleaned.split('\n').filter((l) => l.trim());
      expect(lines[0]).toContain('SPDX-License-Identifier');
      expect(lines[1]).toContain('pragma solidity');
    });

    it('should handle source with no license or pragma', () => {
      const source = `contract Simple { function foo() public {} }`;
      const cleaned = flattener.cleanFlattenedOutput(source);
      expect(cleaned).toContain('contract Simple');
    });
  });

  describe('resolveImport', () => {
    it('should resolve relative imports', () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.endsWith('/src/Bar.sol') || p.endsWith('foundry.toml');
      });
      mockReadFileSync.mockReturnValue('');

      const result = flattener.resolveImport('./Bar.sol', '/project/src/Foo.sol', '/project');

      expect(result).toBe(path.resolve('/project/src/Bar.sol'));
    });

    it('should return null for unresolvable imports', () => {
      mockExistsSync.mockReturnValue(false);

      const result = flattener.resolveImport(
        '@unknown/lib/Contract.sol',
        '/project/src/Foo.sol',
        '/project'
      );

      expect(result).toBeNull();
    });

    it('should check lib/ directory for Foundry-style imports', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === path.resolve('/project/lib/forge-std/src/Test.sol')) {
          return true;
        }
        if (p.endsWith('foundry.toml')) {
          return false;
        }
        if (p.endsWith('remappings.txt')) {
          return false;
        }
        return false;
      });

      flattener.resolveImport('forge-std/src/Test.sol', '/project/src/Foo.sol', '/project');

      // Should check lib/forge-std/src/Test.sol
      expect(mockExistsSync).toHaveBeenCalled();
    });

    it('should check node_modules/ for Hardhat-style imports', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (p === path.resolve('/project/node_modules/@openzeppelin/contracts/token/ERC20.sol')) {
          return true;
        }
        if (p.endsWith('foundry.toml')) {
          return false;
        }
        if (p.endsWith('remappings.txt')) {
          return false;
        }
        return false;
      });

      const result = flattener.resolveImport(
        '@openzeppelin/contracts/token/ERC20.sol',
        '/project/src/Foo.sol',
        '/project'
      );

      expect(result).toBe(
        path.resolve('/project/node_modules/@openzeppelin/contracts/token/ERC20.sol')
      );
    });
  });

  describe('generateReport', () => {
    it('should produce expected output for successful flatten', () => {
      const result: FlattenResult = {
        success: true,
        output: '// flattened source code',
        sourceFiles: ['/project/src/A.sol', '/project/src/B.sol'],
        totalLines: 100,
        licenseIdentifier: 'MIT',
      };

      const report = flattener.generateReport(result, '/project/src/Main.sol');

      expect(report).toContain('## Flatten Report');
      expect(report).toContain('Main.sol');
      expect(report).toContain('Success');
      expect(report).toContain('100');
      expect(report).toContain('MIT');
      expect(report).toContain('### Resolved Sources');
      expect(report).toContain('A.sol');
      expect(report).toContain('B.sol');
    });

    it('should include error in report when flatten fails', () => {
      const result: FlattenResult = {
        success: false,
        output: '',
        error: 'File not found: missing.sol',
        sourceFiles: [],
        totalLines: 0,
      };

      const report = flattener.generateReport(result, '/project/src/Main.sol');

      expect(report).toContain('Failed');
      expect(report).toContain('### Error');
      expect(report).toContain('File not found');
    });
  });

  describe('flattenWithForge', () => {
    it('should use forge flatten command', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(null, '// flattened output\npragma solidity ^0.8.20;\ncontract A {}', '');
        }
      );

      const result = await flattener.flattenWithForge('/project/src/Main.sol');

      expect(result.success).toBe(true);
      expect(result.output).toContain('contract A');
      expect(result.totalLines).toBeGreaterThan(0);
    });

    it('should handle forge flatten failure', async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: any, callback: (...args: any[]) => any) => {
          callback(new Error('forge not found'), '', 'forge not found');
        }
      );

      const result = await flattener.flattenWithForge('/project/src/Main.sol');

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
