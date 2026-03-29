/**
 * Tests for Access Control Analyzer
 */

import { AccessControlAnalyzer } from '../access-control';

describe('AccessControlAnalyzer', () => {
  let analyzer: AccessControlAnalyzer;

  beforeEach(() => {
    analyzer = new AccessControlAnalyzer();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const warnings = analyzer.detect('');
      expect(warnings).toEqual([]);
    });

    it('should return empty array for safe contract with access control', () => {
      const source = `
pragma solidity ^0.8.0;
contract Safe {
    address public owner;
    modifier onlyOwner() { require(msg.sender == owner); _; }

    function mint(address to, uint256 amount) public onlyOwner {
        // mint logic
    }
}
`;
      const warnings = analyzer.detect(source);
      // mint has onlyOwner modifier, so no warning
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });
  });

  describe('detect - missing access control on sensitive functions', () => {
    it('should detect unprotected mint function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function mint(address to, uint256 amount) public {
        // anyone can mint
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeDefined();
      expect(mintWarning!.severity).toBe('high');
      expect(mintWarning!.description).toContain('minting');
    });

    it('should detect unprotected burn function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function burn(uint256 amount) public {
        // anyone can burn
    }
}
`;
      const warnings = analyzer.detect(source);
      const burnWarning = warnings.find((w) => w.functionName === 'burn');
      expect(burnWarning).toBeDefined();
      expect(burnWarning!.severity).toBe('high');
    });

    it('should detect unprotected pause function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function pause() public {
        // anyone can pause
    }
}
`;
      const warnings = analyzer.detect(source);
      const pauseWarning = warnings.find((w) => w.functionName === 'pause');
      expect(pauseWarning).toBeDefined();
    });

    it('should detect unprotected withdraw function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vault {
    function withdraw(uint256 amount) public {
        // anyone can withdraw
    }
}
`;
      const warnings = analyzer.detect(source);
      const withdrawWarning = warnings.find((w) => w.functionName === 'withdraw');
      expect(withdrawWarning).toBeDefined();
      expect(withdrawWarning!.severity).toBe('high');
    });

    it('should detect unprotected setFee function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Protocol {
    function setFee(uint256 newFee) public {
        // anyone can set fee
    }
}
`;
      const warnings = analyzer.detect(source);
      const feeWarning = warnings.find((w) => w.functionName === 'setFee');
      expect(feeWarning).toBeDefined();
      expect(feeWarning!.description).toContain('admin setter');
    });
  });

  describe('detect - protected functions (no false positives)', () => {
    it('should NOT flag function with onlyOwner modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function mint(address to, uint256 amount) public onlyOwner {
        // protected
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });

    it('should NOT flag function with msg.sender check', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    address admin;
    function mint(address to, uint256 amount) public {
        require(msg.sender == admin, "not admin");
        // protected
    }
}
`;
      const warnings = analyzer.detect(source);
      const mintWarning = warnings.find((w) => w.functionName === 'mint');
      expect(mintWarning).toBeUndefined();
    });

    it('should NOT flag view functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag pure functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });

    it('should NOT flag internal/private functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function _mint(address to, uint256 amount) internal {
        // internal minting
    }
}
`;
      const warnings = analyzer.detect(source);
      expect(warnings).toEqual([]);
    });
  });

  describe('detect - centralization risks', () => {
    it('should detect single-owner pause centralization risk', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
contract Token is Pausable {
    function pause() public onlyOwner {
        _pause();
    }
}
`;
      const warnings = analyzer.detect(source);
      const centralWarning = warnings.find((w) => w.description.includes('Centralization'));
      expect(centralWarning).toBeDefined();
      expect(centralWarning!.severity).toBe('medium');
    });

    it('should NOT flag pause with timelock/governance', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
import "./Governance.sol";
contract Token is Pausable, Governance {
    function pause() public onlyOwner {
        _pause();
    }
}
`;
      const warnings = analyzer.detect(source);
      const centralWarning = warnings.find((w) => w.description.includes('Centralization'));
      expect(centralWarning).toBeUndefined();
    });
  });

  describe('detect - Ownable without Ownable2Step', () => {
    it('should warn about Ownable without Ownable2Step', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token is Ownable {
    function mint() public onlyOwner {}
}
`;
      const warnings = analyzer.detect(source);
      const ownable2StepWarning = warnings.find((w) => w.description.includes('Ownable2Step'));
      expect(ownable2StepWarning).toBeDefined();
      expect(ownable2StepWarning!.severity).toBe('medium');
    });

    it('should NOT warn when using Ownable2Step', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token is Ownable2Step {
    function mint() public onlyOwner {}
}
`;
      const warnings = analyzer.detect(source);
      const ownable2StepWarning = warnings.find(
        (w) => w.description.includes('Ownable2Step') && w.description.includes('without')
      );
      expect(ownable2StepWarning).toBeUndefined();
    });
  });

  describe('detect - unprotected initialize()', () => {
    it('should detect unprotected initialize function', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function initialize(address admin) public {
        // anyone can initialize
    }
}
`;
      const warnings = analyzer.detect(source);
      const initWarning = warnings.find((w) => w.functionName === 'initialize');
      expect(initWarning).toBeDefined();
      expect(initWarning!.severity).toBe('critical');
    });

    it('should NOT flag initialize with initializer modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    function initialize(address admin) public initializer {
        // protected by initializer
    }
}
`;
      const warnings = analyzer.detect(source);
      const initWarning = warnings.find(
        (w) => w.functionName === 'initialize' && w.severity === 'critical'
      );
      expect(initWarning).toBeUndefined();
    });
  });

  describe('generateReport', () => {
    it('should generate report with no issues', () => {
      const report = analyzer.generateReport([]);
      expect(report).toContain('Access Control Analysis');
      expect(report).toContain('No access control issues detected');
    });

    it('should generate report with categorized issues', () => {
      const warnings = [
        {
          line: 5,
          functionName: 'initialize',
          severity: 'critical' as const,
          description: 'Unprotected initialize()',
        },
        {
          line: 10,
          functionName: 'mint',
          severity: 'high' as const,
          description: 'No access control on mint',
        },
        {
          line: 15,
          functionName: 'setConfig',
          severity: 'medium' as const,
          description: 'Missing modifier',
        },
      ];

      const report = analyzer.generateReport(warnings);
      expect(report).toContain('**3** issue(s)');
      expect(report).toContain('Critical: 1');
      expect(report).toContain('High: 1');
      expect(report).toContain('Medium: 1');
    });
  });
});
