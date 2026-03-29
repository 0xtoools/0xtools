/**
 * Tests for Upgrade Analyzer - Storage layout compatibility analysis
 */

import { UpgradeAnalyzer } from '../upgrade-analyzer';

describe('UpgradeAnalyzer', () => {
  let analyzer: UpgradeAnalyzer;

  beforeEach(() => {
    analyzer = new UpgradeAnalyzer();
  });

  describe('analyzeUpgrade - compatible changes', () => {
    it('should report identical contracts as compatible', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    address public owner;
}
`;
      const report = analyzer.analyzeUpgrade(source, source, 'Test');
      expect(report.compatible).toBe(true);
      expect(report.diffs).toEqual([]);
      expect(report.contractName).toBe('Test');
    });

    it('should report appending new variables as safe', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    address public owner;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 public value;
    address public owner;
    bool public paused;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(true);
      expect(report.diffs).toEqual([]);
      expect(report.warnings.some((w) => w.includes('appended'))).toBe(true);
    });

    it('should handle empty contracts', () => {
      const source = `
pragma solidity ^0.8.0;
contract Empty {
}
`;
      const report = analyzer.analyzeUpgrade(source, source, 'Empty');
      expect(report.compatible).toBe(true);
      expect(report.diffs).toEqual([]);
    });
  });

  describe('analyzeUpgrade - incompatible changes', () => {
    it('should detect variable removal', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    address owner;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    address owner;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(false);
      expect(report.diffs.length).toBeGreaterThan(0);
      expect(report.warnings.some((w) => w.includes('removed') || w.includes('changed'))).toBe(
        true
      );
    });

    it('should detect variable type change', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    address value;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(false);
      const typeDiff = report.diffs.find((d) => d.issue === 'type_changed');
      expect(typeDiff).toBeDefined();
    });

    it('should detect variable reordering', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 a;
    uint256 b;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 b;
    uint256 a;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(false);
      expect(report.diffs.some((d) => d.issue === 'reordered')).toBe(true);
    });

    it('should detect variable insertion before existing', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 existing;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 newVar;
    uint256 existing;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(false);
      expect(
        report.diffs.some((d) => d.issue === 'inserted_before_existing' || d.issue === 'reordered')
      ).toBe(true);
    });
  });

  describe('analyzeUpgrade - storage gap handling', () => {
    it('should warn when storage gap is removed', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    uint256[49] private __gap;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    uint256 newValue;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.warnings.some((w) => w.includes('gap') && w.includes('removed'))).toBe(true);
    });

    it('should warn when storage gap not reduced for new variables', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    uint256[49] private __gap;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
    uint256 newValue;
    uint256[49] private __gap;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.warnings.some((w) => w.includes('gap') && w.includes('not reduced'))).toBe(
        true
      );
    });
  });

  describe('analyzeUpgrade - constants and immutables', () => {
    it('should skip constant variables', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 constant MAX = 100;
    uint256 value;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 constant MAX = 200;
    uint256 value;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      // Constants don't occupy storage slots, so no slot shift
      expect(report.compatible).toBe(true);
    });

    it('should skip immutable variables', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 immutable DEPLOY_TIME;
    uint256 value;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    uint256 value;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      // Immutable removed should not affect storage layout
      expect(report.compatible).toBe(true);
    });
  });

  describe('analyzeUpgrade - storage packing', () => {
    it('should handle packed storage slots correctly', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    bool a;
    bool b;
    uint256 c;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    bool a;
    bool b;
    uint256 c;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(true);
    });

    it('should handle mappings correctly (always take full slot)', () => {
      const oldSource = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;
    uint256 totalSupply;
}
`;
      const newSource = `
pragma solidity ^0.8.0;
contract Test {
    mapping(address => uint256) balances;
    uint256 totalSupply;
}
`;
      const report = analyzer.analyzeUpgrade(oldSource, newSource, 'Test');
      expect(report.compatible).toBe(true);
    });
  });

  describe('generateReport', () => {
    it('should generate compatible report', () => {
      const upgradeReport = {
        contractName: 'Test',
        compatible: true,
        diffs: [],
        warnings: [],
      };
      const report = analyzer.generateReport(upgradeReport);
      expect(report).toContain('Upgrade Analysis: Test');
      expect(report).toContain('[COMPATIBLE]');
      expect(report).toContain('safe to proceed');
    });

    it('should generate incompatible report with diffs', () => {
      const upgradeReport = {
        contractName: 'Test',
        compatible: false,
        diffs: [
          {
            slot: 0,
            oldVar: 'value',
            newVar: 'newValue',
            oldType: 'uint256',
            newType: 'address',
            issue: 'type_changed' as const,
          },
        ],
        warnings: ['Slot 0: type changed'],
      };
      const report = analyzer.generateReport(upgradeReport);
      expect(report).toContain('[INCOMPATIBLE]');
      expect(report).toContain('Storage Slot Differences');
      expect(report).toContain('value');
      expect(report).toContain('type changed');
    });

    it('should include warnings in the report', () => {
      const upgradeReport = {
        contractName: 'Test',
        compatible: true,
        diffs: [],
        warnings: ['1 new variable(s) appended at the end of storage. This is safe for upgrades.'],
      };
      const report = analyzer.generateReport(upgradeReport);
      expect(report).toContain('Warnings');
      expect(report).toContain('appended');
    });
  });
});
