/**
 * Tests for Dangerous Pattern Detector
 */

import { DangerousPatternDetector } from '../dangerous-patterns';

describe('DangerousPatternDetector', () => {
  let detector: DangerousPatternDetector;

  beforeEach(() => {
    detector = new DangerousPatternDetector();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = detector.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for safe contract', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = detector.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - tx.origin', () => {
    it('should detect tx.origin == comparison', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    address owner;
    function withdraw() public {
        require(tx.origin == owner, "not owner");
    }
}
`;
      const warnings = detector.detect(source);
      const txOriginWarning = warnings.find((w) => w.patternType === 'tx-origin');
      expect(txOriginWarning).toBeDefined();
      expect(txOriginWarning!.severity).toBe('critical');
      expect(txOriginWarning!.description).toContain('phishing');
    });

    it('should detect == tx.origin comparison (reversed)', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    address owner;
    function check() public {
        require(owner == tx.origin, "not owner");
    }
}
`;
      const warnings = detector.detect(source);
      const txOriginWarning = warnings.find((w) => w.patternType === 'tx-origin');
      expect(txOriginWarning).toBeDefined();
    });

    it('should NOT flag tx.origin used for logging (not comparison)', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    event Log(address indexed origin);
    function log() public {
        emit Log(tx.origin);
    }
}
`;
      const warnings = detector.detect(source);
      const txOriginWarning = warnings.find((w) => w.patternType === 'tx-origin');
      expect(txOriginWarning).toBeUndefined();
    });

    it('should skip commented-out tx.origin', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function test() public {
        // require(tx.origin == owner, "not owner");
    }
}
`;
      const warnings = detector.detect(source);
      const txOriginWarning = warnings.find((w) => w.patternType === 'tx-origin');
      expect(txOriginWarning).toBeUndefined();
    });
  });

  describe('detect - selfdestruct', () => {
    it('should detect selfdestruct usage', () => {
      const source = `
pragma solidity ^0.8.0;
contract Destructible {
    function destroy() public {
        selfdestruct(payable(msg.sender));
    }
}
`;
      const warnings = detector.detect(source);
      const sdWarning = warnings.find((w) => w.patternType === 'selfdestruct');
      expect(sdWarning).toBeDefined();
      expect(sdWarning!.severity).toBe('critical');
      expect(sdWarning!.description).toContain('EIP-6049');
    });

    it('should detect SELFDESTRUCT in assembly', () => {
      const source = `
pragma solidity ^0.8.0;
contract Destructible {
    function destroy() public {
        assembly { SELFDESTRUCT }
    }
}
`;
      const warnings = detector.detect(source);
      const sdWarning = warnings.find((w) => w.patternType === 'selfdestruct');
      expect(sdWarning).toBeDefined();
    });
  });

  describe('detect - unsafe delegatecall', () => {
    it('should detect delegatecall to variable target', () => {
      const source = `
pragma solidity ^0.8.0;
contract Proxy {
    function execute(address target) public {
        target.delegatecall(abi.encodeWithSignature("run()"));
    }
}
`;
      const warnings = detector.detect(source);
      const dcWarning = warnings.find((w) => w.patternType === 'unsafe-delegatecall');
      expect(dcWarning).toBeDefined();
      expect(dcWarning!.severity).toBe('critical');
      expect(dcWarning!.description).toContain('target');
    });

    it('should NOT flag delegatecall to this', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function execute() public {
        address(this).delegatecall(abi.encodeWithSignature("run()"));
    }
}
`;
      const warnings = detector.detect(source);
      const dcWarning = warnings.find((w) => w.patternType === 'unsafe-delegatecall');
      expect(dcWarning).toBeUndefined();
    });

    it('should NOT flag delegatecall to constant address', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    function execute() public {
        IMPLEMENTATION.delegatecall(abi.encodeWithSignature("run()"));
    }
}
`;
      const warnings = detector.detect(source);
      const dcWarning = warnings.find((w) => w.patternType === 'unsafe-delegatecall');
      expect(dcWarning).toBeUndefined();
    });
  });

  describe('detect - uninitialized proxy', () => {
    it('should detect upgradeable contract without _disableInitializers', () => {
      const source = `pragma solidity ^0.8.0;
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
contract Token is Initializable {
    constructor() {
        uint256 x = 1;
    }
    function initialize() public initializer {
        // init
    }
}`;
      const warnings = detector.detect(source);
      const proxyWarning = warnings.find((w) => w.patternType === 'uninitialized-proxy');
      expect(proxyWarning).toBeDefined();
      expect(proxyWarning!.severity).toBe('high');
    });

    it('should NOT flag constructor with _disableInitializers', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
contract Token is Initializable {
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        // init
    }
}
`;
      const warnings = detector.detect(source);
      const proxyWarning = warnings.find((w) => w.patternType === 'uninitialized-proxy');
      expect(proxyWarning).toBeUndefined();
    });

    it('should NOT flag non-upgradeable contracts', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    constructor() {
        // regular contract
    }
}
`;
      const warnings = detector.detect(source);
      const proxyWarning = warnings.find((w) => w.patternType === 'uninitialized-proxy');
      expect(proxyWarning).toBeUndefined();
    });
  });

  describe('detect - hardcoded decimals', () => {
    it('should detect * 1e18 usage', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function convert(uint256 amount) public pure returns (uint256) {
        return amount * 1e18;
    }
}
`;
      const warnings = detector.detect(source);
      const decimalWarning = warnings.find((w) => w.patternType === 'hardcoded-decimals');
      expect(decimalWarning).toBeDefined();
      expect(decimalWarning!.severity).toBe('medium');
      expect(decimalWarning!.description).toContain('USDC');
    });

    it('should detect / 10**18 usage', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function convert(uint256 amount) public pure returns (uint256) {
        return amount / 10**18;
    }
}
`;
      const warnings = detector.detect(source);
      const decimalWarning = warnings.find((w) => w.patternType === 'hardcoded-decimals');
      expect(decimalWarning).toBeDefined();
    });

    it('should NOT flag ether keyword usage with 1e18', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function convert() public pure returns (uint256) {
        return 1 ether * 1e18;
    }
}
`;
      const warnings = detector.detect(source);
      const decimalWarning = warnings.find((w) => w.patternType === 'hardcoded-decimals');
      expect(decimalWarning).toBeUndefined();
    });
  });

  describe('detect - function name tracking', () => {
    it('should correctly associate patterns with their enclosing function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Test {
    function safe() public pure returns (uint256) {
        return 1;
    }

    function vulnerable() public {
        selfdestruct(payable(msg.sender));
    }
}
`;
      const warnings = detector.detect(source);
      const sdWarning = warnings.find((w) => w.patternType === 'selfdestruct');
      expect(sdWarning).toBeDefined();
      expect(sdWarning!.functionName).toBe('vulnerable');
    });
  });

  describe('generateReport', () => {
    it('should generate report with no patterns', () => {
      const report = detector.generateReport([]);
      expect(report).toContain('Dangerous Pattern Analysis');
      expect(report).toContain('No dangerous patterns detected');
    });

    it('should generate report sorted by severity', () => {
      const warnings = [
        {
          line: 10,
          functionName: 'convert',
          patternType: 'hardcoded-decimals' as const,
          severity: 'medium' as const,
          description: 'Hardcoded decimals',
        },
        {
          line: 5,
          functionName: 'auth',
          patternType: 'tx-origin' as const,
          severity: 'critical' as const,
          description: 'tx.origin auth',
        },
      ];

      const report = detector.generateReport(warnings);
      expect(report).toContain('**2** dangerous pattern(s)');
      // Critical should come before medium in the report
      const criticalPos = report.indexOf('[CRITICAL]');
      const mediumPos = report.indexOf('[MEDIUM]');
      expect(criticalPos).toBeLessThan(mediumPos);
    });
  });
});
