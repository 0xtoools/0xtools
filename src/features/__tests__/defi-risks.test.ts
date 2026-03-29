/**
 * Tests for DeFi Risk Detector
 */

import { DeFiRiskDetector } from '../defi-risks';

describe('DeFiRiskDetector', () => {
  let detector: DeFiRiskDetector;

  beforeEach(() => {
    detector = new DeFiRiskDetector();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = detector.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for non-DeFi contract', () => {
      const source = `
pragma solidity ^0.8.0;
contract Simple {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - stale oracle', () => {
    it('should detect deprecated latestAnswer()', () => {
      const source = `
pragma solidity ^0.8.0;
contract PriceFeed {
    function getPrice(address feed) public view returns (int256) {
        return AggregatorV3Interface(feed).latestAnswer();
    }
}
`;
      const warnings = detector.detect(source);
      const oracleWarning = warnings.find((w) => w.riskType === 'stale-oracle');
      expect(oracleWarning).toBeDefined();
      expect(oracleWarning!.severity).toBe('high');
      expect(oracleWarning!.description).toContain('deprecated');
    });

    it('should detect latestRoundData without staleness check', () => {
      const source = `
pragma solidity ^0.8.0;
contract PriceFeed {
    function getPrice(address feed) public view returns (int256) {
        (, int256 price, , , ) = AggregatorV3Interface(feed).latestRoundData();
        return price;
    }
}
`;
      const warnings = detector.detect(source);
      const oracleWarning = warnings.find((w) => w.riskType === 'stale-oracle');
      expect(oracleWarning).toBeDefined();
      expect(oracleWarning!.description).toContain('updatedAt');
    });

    it('should NOT flag latestRoundData with updatedAt check', () => {
      const source = `
pragma solidity ^0.8.0;
contract PriceFeed {
    function getPrice(address feed) public view returns (int256) {
        (, int256 price, , uint256 updatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
        require(block.timestamp - updatedAt < 3600, "stale");
        return price;
    }
}
`;
      const warnings = detector.detect(source);
      const staleWarning = warnings.find(
        (w) => w.riskType === 'stale-oracle' && w.functionName === 'getPrice'
      );
      expect(staleWarning).toBeUndefined();
    });
  });

  describe('detect - precision loss', () => {
    it('should detect division before multiplication', () => {
      const source = `
pragma solidity ^0.8.0;
contract Math {
    function compute(uint256 a, uint256 b, uint256 c) public pure returns (uint256) {
        return a / b * c;
    }
}
`;
      const warnings = detector.detect(source);
      const precisionWarning = warnings.find((w) => w.riskType === 'precision-loss');
      expect(precisionWarning).toBeDefined();
      expect(precisionWarning!.severity).toBe('medium');
      expect(precisionWarning!.description).toContain('Division before multiplication');
    });

    it('should NOT flag multiplication before division', () => {
      const source = `
pragma solidity ^0.8.0;
contract Math {
    function compute(uint256 a, uint256 b, uint256 c) public pure returns (uint256) {
        return a * b / c;
    }
}
`;
      const warnings = detector.detect(source);
      const precisionWarning = warnings.find((w) => w.riskType === 'precision-loss');
      expect(precisionWarning).toBeUndefined();
    });
  });

  describe('detect - infinite approval', () => {
    it('should detect type(uint256).max approval', () => {
      const source = `
pragma solidity ^0.8.0;
contract Router {
    function setup(address token, address spender) public {
        IERC20(token).approve(spender, type(uint256).max);
    }
}
`;
      const warnings = detector.detect(source);
      const approvalWarning = warnings.find((w) => w.riskType === 'infinite-approval');
      expect(approvalWarning).toBeDefined();
      expect(approvalWarning!.severity).toBe('medium');
      expect(approvalWarning!.description).toContain('Infinite');
    });

    it('should detect uint256(-1) approval', () => {
      const source = `
pragma solidity ^0.8.0;
contract Router {
    function setup(address token, address spender) public {
        IERC20(token).approve(spender, uint256(-1));
    }
}
`;
      const warnings = detector.detect(source);
      const approvalWarning = warnings.find((w) => w.riskType === 'infinite-approval');
      expect(approvalWarning).toBeDefined();
    });

    it('should NOT flag finite approval', () => {
      const source = `
pragma solidity ^0.8.0;
contract Router {
    function setup(address token, address spender, uint256 amount) public {
        IERC20(token).approve(spender, amount);
    }
}
`;
      const warnings = detector.detect(source);
      const approvalWarning = warnings.find((w) => w.riskType === 'infinite-approval');
      expect(approvalWarning).toBeUndefined();
    });
  });

  describe('detect - missing zero-address check', () => {
    it('should detect missing zero-address check on transfer recipient', () => {
      const source = `pragma solidity ^0.8.0;
contract Token {
    function send(address recipient) external {
        owner = recipient;
    }
}
`;
      const warnings = detector.detect(source);
      const zeroAddrWarning = warnings.find((w) => w.riskType === 'zero-address');
      expect(zeroAddrWarning).toBeDefined();
      expect(zeroAddrWarning!.description).toContain('recipient');
    });

    it('should NOT flag when zero-address check is present', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function send(address recipient) external {
        require(recipient != address(0), "zero");
        payable(recipient).transfer(100);
    }
}
`;
      const warnings = detector.detect(source);
      const zeroAddrWarning = warnings.find((w) => w.riskType === 'zero-address');
      expect(zeroAddrWarning).toBeUndefined();
    });

    it('should NOT flag internal/private functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function _send(address recipient) internal {
        payable(recipient).transfer(100);
    }
}
`;
      const warnings = detector.detect(source);
      const zeroAddrWarning = warnings.find((w) => w.riskType === 'zero-address');
      expect(zeroAddrWarning).toBeUndefined();
    });
  });

  describe('detect - ERC4626 vault inflation', () => {
    it('should detect ERC4626 without virtual offset protection', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vault is ERC4626 {
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        // no protection
    }
}
`;
      const warnings = detector.detect(source);
      const vaultWarning = warnings.find((w) => w.riskType === 'vault-inflation');
      expect(vaultWarning).toBeDefined();
      expect(vaultWarning!.severity).toBe('high');
      expect(vaultWarning!.description).toContain('inflation');
    });

    it('should NOT flag ERC4626 with _decimalsOffset', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vault is ERC4626 {
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
`;
      const warnings = detector.detect(source);
      const vaultWarning = warnings.find((w) => w.riskType === 'vault-inflation');
      expect(vaultWarning).toBeUndefined();
    });

    it('should NOT flag non-ERC4626 contracts', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token is ERC20 {
    function deposit() public {}
}
`;
      const warnings = detector.detect(source);
      const vaultWarning = warnings.find((w) => w.riskType === 'vault-inflation');
      expect(vaultWarning).toBeUndefined();
    });
  });

  describe('detect - comment handling', () => {
    it('should skip commented-out code', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function test() public {
        // latestAnswer();
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('generateReport', () => {
    it('should generate report with no warnings', () => {
      const report = detector.generateReport([]);
      expect(report).toContain('DeFi Risk Analysis Report');
      expect(report).toContain('No DeFi-specific vulnerabilities detected');
    });

    it('should generate report with categorized warnings', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'getPrice',
          riskType: 'stale-oracle' as const,
          severity: 'high' as const,
          description: 'Stale oracle data',
        },
        {
          line: 10,
          functionName: 'swap',
          riskType: 'precision-loss' as const,
          severity: 'medium' as const,
          description: 'Division before multiplication',
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('**2** potential DeFi risk(s)');
      expect(report).toContain('High: 1');
      expect(report).toContain('Medium: 1');
      expect(report).toContain('Stale Oracle Price');
      expect(report).toContain('Precision Loss');
    });
  });
});
