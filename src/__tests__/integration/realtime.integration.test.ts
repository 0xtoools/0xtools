/**
 * Integration tests for real-time analysis features
 * NOTE: These tests are currently skipped because they require a full VS Code environment
 * with file system access. To properly test these features, run the extension in VS Code
 * with the Extension Development Host.
 */

// Mock vscode module
jest.mock('vscode');

import { RealtimeAnalyzer } from '../../features/realtime';
import * as vscode from 'vscode';

describe.skip('RealtimeAnalyzer Integration', () => {
  let analyzer: RealtimeAnalyzer;
  let diagnosticCollection: vscode.DiagnosticCollection;

  beforeEach(() => {
    diagnosticCollection = {
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
      dispose: jest.fn(),
      name: 'test',
      forEach: jest.fn(),
      get: jest.fn(),
      has: jest.fn(),
    } as unknown as vscode.DiagnosticCollection;

    analyzer = new RealtimeAnalyzer(diagnosticCollection);
  });

  describe('Document Analysis', () => {
    it('should analyze simple contract with low gas', async () => {
      const content = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract SimpleToken {
    mapping(address => uint256) public balances;
    
    function transfer(address to, uint256 amount) public returns (bool) {
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }
}`;

      const document = createMockDocument(content, 'SimpleToken.sol');
      const analysis = await analyzer.analyzeDocument(document);

      expect(analysis.gasEstimates.size).toBeGreaterThan(0);
      expect(analysis.sizeInfo).toBeTruthy();
      expect(analysis.sizeInfo?.status).toBe('safe');
    });

    it('should detect high gas functions', async () => {
      const content = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ExpensiveContract {
    uint256[] public data;
    
    function expensiveLoop(uint256 iterations) public {
        for (uint256 i = 0; i < iterations; i++) {
            data.push(i);
            emit DataAdded(i);
        }
    }
    
    event DataAdded(uint256 value);
}`;

      const document = createMockDocument(content, 'ExpensiveContract.sol');
      const analysis = await analyzer.analyzeDocument(document);

      const gasEstimate = analysis.gasEstimates.get('expensiveLoop');
      expect(gasEstimate).toBeTruthy();
      expect(['high', 'very-high']).toContain(gasEstimate?.complexity);
      expect(gasEstimate?.warning).toContain('unbounded');
    });

    it('should detect high complexity functions', async () => {
      const content = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ComplexContract {
    function complexLogic(uint256 a, uint256 b, uint256 c) public returns (uint256) {
        if (a > 10) {
            if (b > 20) {
                if (c > 30) {
                    return a + b + c;
                } else if (c > 20) {
                    return a + b - c;
                } else if (c > 10) {
                    return a - b + c;
                } else {
                    return a - b - c;
                }
            } else if (b > 10) {
                return a + b;
            }
        } else if (a > 5) {
            return b + c;
        }
        return 0;
    }
}`;

      const document = createMockDocument(content, 'ComplexContract.sol');
      const analysis = await analyzer.analyzeDocument(document);

      const complexity = analysis.complexityMetrics.get('complexLogic');
      expect(complexity).toBeTruthy();
      expect(complexity?.cyclomaticComplexity).toBeGreaterThan(10);
      expect(['C', 'D', 'F']).toContain(complexity?.rating);
    });

    it('should detect contract size warnings', async () => {
      // Generate large contract
      let content = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract LargeContract {
`;
      // Add many functions to increase size
      for (let i = 0; i < 100; i++) {
        content += `
    function func${i}(uint256 a, uint256 b) public pure returns (uint256) {
        uint256 result = a + b;
        require(result > 0, "Result must be greater than zero");
        return result * 2;
    }
`;
      }
      content += '}';

      const document = createMockDocument(content, 'LargeContract.sol');
      const analysis = await analyzer.analyzeDocument(document);

      expect(analysis.sizeInfo).toBeTruthy();
      expect(analysis.sizeInfo?.sizeInKB).toBeGreaterThan(10);
    });
  });

  describe('Diagnostics', () => {
    it('should create diagnostics for high gas functions', async () => {
      const content = `
pragma solidity ^0.8.0;
contract Test {
    uint256[] data;
    function loop() public {
        for(uint i=0; i<1000; i++) { data.push(i); }
    }
}`;

      const document = createMockDocument(content, 'Test.sol');
      const analysis = await analyzer.analyzeDocument(document);

      expect(analysis.diagnostics.length).toBeGreaterThan(0);
      const gasDiagnostic = analysis.diagnostics.find((d) => d.source === '0xTools Gas');
      expect(gasDiagnostic).toBeTruthy();
    });

    it('should create diagnostics for high complexity', async () => {
      const content = `
pragma solidity ^0.8.0;
contract Test {
    function complex(uint a) public returns (uint) {
        if(a>1){if(a>2){if(a>3){if(a>4){if(a>5){return a;}}}}}
        return 0;
    }
}`;

      const document = createMockDocument(content, 'Test.sol');
      const analysis = await analyzer.analyzeDocument(document);

      const complexityDiagnostic = analysis.diagnostics.find(
        (d) => d.source === '0xTools Complexity'
      );
      expect(complexityDiagnostic).toBeTruthy();
    });
  });

  describe('Decorations', () => {
    it('should create gas decorations', async () => {
      const content = `
pragma solidity ^0.8.0;
contract Test {
    function transfer(address to, uint amount) public { }
}`;

      const document = createMockDocument(content, 'Test.sol');
      const analysis = await analyzer.analyzeDocument(document);
      const decorations = analyzer.createGasDecorations(analysis, document);

      expect(decorations.length).toBeGreaterThan(0);
      expect(decorations[0].renderOptions?.after?.contentText).toContain('gas');
    });

    it('should create complexity decorations', async () => {
      const content = `
pragma solidity ^0.8.0;
contract Test {
    function complex(uint a) public returns (uint) {
        if(a>1){if(a>2){if(a>3){return a;}}}
        return 0;
    }
}`;

      const document = createMockDocument(content, 'Test.sol');
      const analysis = await analyzer.analyzeDocument(document);
      const decorations = analyzer.createComplexityDecorations(analysis, document);

      expect(decorations.length).toBeGreaterThan(0);
    });
  });

  describe('Hover Information', () => {
    it('should provide hover info for functions', async () => {
      const content = `
pragma solidity ^0.8.0;
contract Test {
    function transfer(address to, uint amount) public returns (bool) {
        return true;
    }
}`;

      const document = createMockDocument(content, 'Test.sol');
      const analysis = await analyzer.analyzeDocument(document);

      const position = new vscode.Position(3, 15); // Position on "transfer"
      const hover = analyzer.createHoverInfo(position, analysis, document);

      expect(hover).toBeTruthy();
      expect(hover?.contents[0]).toBeTruthy();
    });
  });

  describe('Caching', () => {
    it('should cache analysis results', async () => {
      const content = `pragma solidity ^0.8.0; contract Test {}`;
      const document = createMockDocument(content, 'Test.sol');

      const analysis1 = await analyzer.analyzeDocument(document);
      const analysis2 = await analyzer.analyzeDocument(document);

      expect(analysis1).toBe(analysis2); // Same object reference
    });

    it('should clear cache on demand', async () => {
      const content = `pragma solidity ^0.8.0; contract Test {}`;
      const document = createMockDocument(content, 'Test.sol');

      await analyzer.analyzeDocument(document);
      analyzer.clearCache(document.uri);

      // Should re-analyze after cache clear
      const analysis = await analyzer.analyzeDocument(document);
      expect(analysis).toBeTruthy();
    });
  });
});

// Helper function to create mock document
function createMockDocument(content: string, fileName: string): vscode.TextDocument {
  const lines = content.split('\n');
  return {
    uri: vscode.Uri.file(`/test/${fileName}`),
    fileName: `/test/${fileName}`,
    languageId: 'solidity',
    version: 1,
    isDirty: false,
    isClosed: false,
    eol: vscode.EndOfLine.LF,
    lineCount: lines.length,
    save: jest.fn(),
    getText: jest.fn(() => content),
    getWordRangeAtPosition: jest.fn((position: vscode.Position) => {
      const line = lines[position.line] || '';
      const words = line.match(/\w+/g) || [];
      let charCount = 0;
      for (const word of words) {
        const start = line.indexOf(word, charCount);
        const end = start + word.length;
        if (position.character >= start && position.character <= end) {
          return new vscode.Range(
            new vscode.Position(position.line, start),
            new vscode.Position(position.line, end)
          );
        }
        charCount = end;
      }
      return undefined;
    }),
    lineAt: jest.fn((line: number) => ({
      lineNumber: line,
      text: lines[line] || '',
      range: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, (lines[line] || '').length)
      ),
      rangeIncludingLineBreak: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, (lines[line] || '').length + 1)
      ),
      firstNonWhitespaceCharacterIndex: 0,
      isEmptyOrWhitespace: (lines[line] || '').trim().length === 0,
    })),
    offsetAt: jest.fn((position: vscode.Position) => {
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      offset += position.character;
      return offset;
    }),
    positionAt: jest.fn((offset: number) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return new vscode.Position(i, remaining);
        }
        remaining -= lines[i].length + 1; // +1 for newline
      }
      return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    }),
    validateRange: jest.fn((range) => range),
    validatePosition: jest.fn((position) => position),
  } as unknown as vscode.TextDocument;
}
