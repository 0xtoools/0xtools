/**
 * Tests for Invariant Detector - Pattern-match Solidity source for common invariants
 */

import { InvariantDetector } from '../invariant-detector';

describe('InvariantDetector', () => {
  let detector: InvariantDetector;

  beforeEach(() => {
    detector = new InvariantDetector();
  });

  describe('detect - empty/trivial input', () => {
    it('should return empty array for empty source', () => {
      const invariants = detector.detect('');
      expect(invariants).toEqual([]);
    });

    it('should return empty array for contract with no invariant patterns', () => {
      const source = `
pragma solidity ^0.8.0;
contract Simple {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const invariants = detector.detect(source);
      expect(invariants).toEqual([]);
    });
  });

  describe('detect - balance tracking', () => {
    it('should detect balance tracking with mapping named balances', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    mapping(address => uint256) public balances;
    uint256 public totalSupply;

    function transfer(address to, uint256 amount) public {
        balances[msg.sender] -= amount;
        balances[to] += amount;
    }
}
`;
      const invariants = detector.detect(source);
      const balanceInv = invariants.find((i) => i.type === 'balance_tracking');
      expect(balanceInv).toBeDefined();
      expect(balanceInv!.confidence).toBe('high');
      expect(balanceInv!.relatedFunctions).toContain('transfer');
    });

    it('should detect balance tracking with _balances mapping', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    mapping(address => uint256) private _balances;

    function mint(address to, uint256 amount) public {
        _balances[to] += amount;
    }
}
`;
      const invariants = detector.detect(source);
      const balanceInv = invariants.find((i) => i.type === 'balance_tracking');
      expect(balanceInv).toBeDefined();
      expect(balanceInv!.relatedFunctions).toContain('mint');
    });

    it('should have lower confidence when no transfer-like functions exist', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    mapping(address => uint256) public balances;

    function getBalance(address user) public view returns (uint256) {
        return balances[user];
    }
}
`;
      const invariants = detector.detect(source);
      const balanceInv = invariants.find((i) => i.type === 'balance_tracking');
      // May or may not be detected with low confidence
      if (balanceInv) {
        expect(['low', 'medium']).toContain(balanceInv.confidence);
      }
    });
  });

  describe('detect - ownership', () => {
    it('should detect ownership pattern with onlyOwner modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Owned {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setFee(uint256 fee) public onlyOwner {
        // set fee
    }
}
`;
      const invariants = detector.detect(source);
      const ownerInv = invariants.find((i) => i.type === 'ownership');
      expect(ownerInv).toBeDefined();
      expect(ownerInv!.confidence).toBe('high');
      expect(ownerInv!.relatedFunctions).toContain('setFee');
    });

    it('should detect ownership with msg.sender == owner check', () => {
      const source = `
pragma solidity ^0.8.0;
contract Owned {
    address public owner;

    function withdraw() public {
        require(msg.sender == owner, "not owner");
        // withdraw
    }
}
`;
      const invariants = detector.detect(source);
      const ownerInv = invariants.find((i) => i.type === 'ownership');
      expect(ownerInv).toBeDefined();
    });

    it('should detect transferOwnership in related functions', () => {
      const source = `
pragma solidity ^0.8.0;
contract Owned {
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        owner = newOwner;
    }
}
`;
      const invariants = detector.detect(source);
      const ownerInv = invariants.find((i) => i.type === 'ownership');
      expect(ownerInv).toBeDefined();
      expect(ownerInv!.relatedFunctions).toContain('transferOwnership');
    });

    it('should NOT detect ownership without owner variable', () => {
      const source = `
pragma solidity ^0.8.0;
contract NoOwner {
    function doSomething() public {
        // no owner check
    }
}
`;
      const invariants = detector.detect(source);
      const ownerInv = invariants.find((i) => i.type === 'ownership');
      expect(ownerInv).toBeUndefined();
    });
  });

  describe('detect - reentrancy guard', () => {
    it('should detect nonReentrant modifier', () => {
      const source = `
pragma solidity ^0.8.0;
contract Protected {
    bool private _locked;

    modifier nonReentrant() {
        require(!_locked, "reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    function withdraw() public nonReentrant {
        msg.sender.transfer(100);
    }
}
`;
      const invariants = detector.detect(source);
      const reentrancyInv = invariants.find((i) => i.type === 'reentrancy_guard');
      expect(reentrancyInv).toBeDefined();
      expect(reentrancyInv!.confidence).toBe('high');
    });

    it('should detect ReentrancyGuard import', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
contract Protected is ReentrancyGuard {
    function withdraw() public nonReentrant {
        msg.sender.transfer(100);
    }
}
`;
      const invariants = detector.detect(source);
      const reentrancyInv = invariants.find((i) => i.type === 'reentrancy_guard');
      expect(reentrancyInv).toBeDefined();
      expect(reentrancyInv!.confidence).toBe('high');
    });

    it('should detect CEI pattern as low confidence', () => {
      const source = `
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint256) balances;

    function withdraw(uint256 amount) public {
        balances[msg.sender] = 0;
        msg.sender.transfer(amount);
    }
}
`;
      const invariants = detector.detect(source);
      const reentrancyInv = invariants.find((i) => i.type === 'reentrancy_guard');
      if (reentrancyInv) {
        expect(reentrancyInv.confidence).toBe('low');
      }
    });
  });

  describe('detect - access control', () => {
    it('should detect role-based access control', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/access/AccessControl.sol";
contract Managed is AccessControl {
    function mint(address to, uint256 amount) public {
        require(hasRole(MINTER_ROLE, msg.sender), "not minter");
        // mint
    }
}
`;
      const invariants = detector.detect(source);
      const accessInv = invariants.find((i) => i.type === 'access_control');
      expect(accessInv).toBeDefined();
      expect(accessInv!.confidence).toBe('high');
    });

    it('should detect custom modifier-based access control', () => {
      const source = `
pragma solidity ^0.8.0;
contract Managed {
    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function setConfig(uint256 val) public onlyAdmin {
        // set config
    }
}
`;
      const invariants = detector.detect(source);
      const accessInv = invariants.find((i) => i.type === 'access_control');
      expect(accessInv).toBeDefined();
    });
  });

  describe('detect - pausable', () => {
    it('should detect Pausable import pattern', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
contract Token is Pausable {
    function transfer(address to, uint256 amount) public whenNotPaused {
        // transfer
    }

    function pause() public {
        _pause();
    }
}
`;
      const invariants = detector.detect(source);
      const pausableInv = invariants.find((i) => i.type === 'pausable');
      expect(pausableInv).toBeDefined();
      expect(pausableInv!.confidence).toBe('high');
      expect(pausableInv!.relatedFunctions).toContain('transfer');
      expect(pausableInv!.relatedFunctions).toContain('pause');
    });

    it('should detect custom paused variable', () => {
      const source = `
pragma solidity ^0.8.0;
contract Token {
    bool public paused;

    function pause() public {
        paused = true;
    }

    function unpause() public {
        paused = false;
    }
}
`;
      const invariants = detector.detect(source);
      const pausableInv = invariants.find((i) => i.type === 'pausable');
      expect(pausableInv).toBeDefined();
    });

    it('should NOT detect pausable in contract without pause patterns', () => {
      const source = `
pragma solidity ^0.8.0;
contract Simple {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b;
    }
}
`;
      const invariants = detector.detect(source);
      const pausableInv = invariants.find((i) => i.type === 'pausable');
      expect(pausableInv).toBeUndefined();
    });
  });

  describe('detect - multiple invariants', () => {
    it('should detect multiple invariant patterns in one contract', () => {
      const source = `
pragma solidity ^0.8.0;
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Token is Pausable, ReentrancyGuard {
    address public owner;
    mapping(address => uint256) public balances;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transfer(address to, uint256 amount) public whenNotPaused nonReentrant {
        balances[msg.sender] -= amount;
        balances[to] += amount;
    }

    function pause() public onlyOwner {
        _pause();
    }
}
`;
      const invariants = detector.detect(source);
      const types = invariants.map((i) => i.type);
      expect(types).toContain('balance_tracking');
      expect(types).toContain('ownership');
      expect(types).toContain('reentrancy_guard');
      expect(types).toContain('pausable');
    });
  });
});
