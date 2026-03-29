/**
 * Solidity Code Snippet Provider
 *
 * Provides a comprehensive set of production-quality Solidity code snippets
 * that can be registered as VS Code completion items. Snippets use the
 * standard ${N:placeholder} syntax for tabstop expansion.
 *
 * Standalone — no VS Code dependency required.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SoliditySnippet {
  prefix: string;
  label: string;
  description: string;
  body: string;
  category: string;
}

// ---------------------------------------------------------------------------
// SnippetProvider — Singleton with frozen snippet array
// ---------------------------------------------------------------------------

/** Module-level frozen snippet array, built once and shared across all instances. */
let _frozenSnippets: readonly SoliditySnippet[] | null = null;
/** Pre-computed category list (built once). */
let _frozenCategories: string[] | null = null;
/** Pre-computed category -> snippets map for O(1) lookup (built once). */
let _categoryMap: Map<string, SoliditySnippet[]> | null = null;
/** Pre-computed lowercased search fields for each snippet (built once). */
let _searchIndex: Array<{
  snippet: SoliditySnippet;
  prefix: string;
  label: string;
  description: string;
}> | null = null;

function getSnippets(): readonly SoliditySnippet[] {
  if (!_frozenSnippets) {
    _frozenSnippets = Object.freeze(buildAllSnippets());
  }
  return _frozenSnippets;
}

function getCategoryList(): string[] {
  if (!_frozenCategories) {
    const cats = new Set<string>();
    for (const s of getSnippets()) {
      cats.add(s.category);
    }
    _frozenCategories = Array.from(cats);
  }
  return _frozenCategories;
}

function getCategoryMap(): Map<string, SoliditySnippet[]> {
  if (!_categoryMap) {
    _categoryMap = new Map();
    for (const s of getSnippets()) {
      const key = s.category.toLowerCase();
      let arr = _categoryMap.get(key);
      if (!arr) {
        arr = [];
        _categoryMap.set(key, arr);
      }
      arr.push(s);
    }
  }
  return _categoryMap;
}

function getSearchIndex(): Array<{
  snippet: SoliditySnippet;
  prefix: string;
  label: string;
  description: string;
}> {
  if (!_searchIndex) {
    _searchIndex = [];
    for (const s of getSnippets()) {
      _searchIndex.push({
        snippet: s,
        prefix: s.prefix.toLowerCase(),
        label: s.label.toLowerCase(),
        description: s.description.toLowerCase(),
      });
    }
  }
  return _searchIndex;
}

/** Singleton instance for reuse across commands. */
let _singleton: SnippetProvider | null = null;

export class SnippetProvider {
  private snippets: readonly SoliditySnippet[];

  constructor() {
    this.snippets = getSnippets();
    // Reuse singleton if available
    if (_singleton) {
      return _singleton;
    }
    _singleton = this; // eslint-disable-line @typescript-eslint/no-this-alias
  }

  /** Get all snippets. */
  getAll(): readonly SoliditySnippet[] {
    return this.snippets;
  }

  /** Get snippets by category (O(1) lookup via pre-computed map). */
  getByCategory(category: string): SoliditySnippet[] {
    return getCategoryMap().get(category.toLowerCase()) || [];
  }

  /** Get distinct category names. */
  getCategories(): string[] {
    return getCategoryList();
  }

  /** Search snippets by prefix or label (case-insensitive substring match, pre-lowered index). */
  search(query: string): SoliditySnippet[] {
    const lower = query.toLowerCase();
    const index = getSearchIndex();
    const results: SoliditySnippet[] = [];
    for (const entry of index) {
      if (
        entry.prefix.includes(lower) ||
        entry.label.includes(lower) ||
        entry.description.includes(lower)
      ) {
        results.push(entry.snippet);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Snippet definitions
// ---------------------------------------------------------------------------

function buildAllSnippets(): SoliditySnippet[] {
  return [
    // -----------------------------------------------------------------------
    // Token Standards
    // -----------------------------------------------------------------------
    {
      prefix: 'erc20',
      label: 'ERC20 Token',
      description: 'Full ERC20 token contract with transfer, approve, transferFrom',
      category: 'Token Standards',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:MyToken} {
    string public name = "\${2:My Token}";
    string public symbol = "\${3:MTK}";
    uint8 public decimals = \${4:18};
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 _initialSupply) {
        totalSupply = _initialSupply * 10 ** decimals;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 value) public returns (bool) {
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) public returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        require(balanceOf[from] >= value, "Insufficient balance");
        require(allowance[from][msg.sender] >= value, "Insufficient allowance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        allowance[from][msg.sender] -= value;
        emit Transfer(from, to, value);
        return true;
    }
}`,
    },
    {
      prefix: 'erc721',
      label: 'ERC721 NFT',
      description: 'Full ERC721 non-fungible token contract',
      category: 'Token Standards',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

contract \${1:MyNFT} {
    string public name = "\${2:My NFT}";
    string public symbol = "\${3:MNFT}";

    uint256 private _tokenIdCounter;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "Zero address");
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "Nonexistent token");
        return owner;
    }

    function approve(address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "Not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_owners[tokenId] != address(0), "Nonexistent token");
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "Not authorized");
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) public {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        require(_isApprovedOrOwner(msg.sender, tokenId), "Not authorized");
        _transfer(from, to, tokenId);
        require(_checkOnERC721Received(from, to, tokenId, data), "Non-ERC721Receiver");
    }

    function mint(address to) public returns (uint256) {
        uint256 tokenId = _tokenIdCounter++;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(address(0), to, tokenId);
        return tokenId;
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(ownerOf(tokenId) == from, "Wrong owner");
        require(to != address(0), "Zero address");
        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return (spender == owner || getApproved(tokenId) == spender || isApprovedForAll(owner, spender));
    }

    function _checkOnERC721Received(address from, address to, uint256 tokenId, bytes memory data) private returns (bool) {
        if (to.code.length > 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 retval) {
                return retval == IERC721Receiver.onERC721Received.selector;
            } catch {
                return false;
            }
        }
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == 0x80ac58cd || interfaceId == 0x01ffc9a7;
    }
}`,
    },
    {
      prefix: 'erc1155',
      label: 'ERC1155 Multi-Token',
      description: 'Full ERC1155 multi-token contract with batch transfers',
      category: 'Token Standards',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC1155Receiver {
    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata data) external returns (bytes4);
    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata data) external returns (bytes4);
}

contract \${1:MultiToken} {
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    string private _uri;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);
    event URI(string value, uint256 indexed id);

    constructor(string memory uri_) {
        _uri = uri_;
    }

    function uri(uint256) public view returns (string memory) {
        return _uri;
    }

    function balanceOf(address account, uint256 id) public view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) public view returns (uint256[] memory) {
        require(accounts.length == ids.length, "Length mismatch");
        uint256[] memory batchBalances = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            batchBalances[i] = _balances[ids[i]][accounts[i]];
        }
        return batchBalances;
    }

    function setApprovalForAll(address operator, bool approved) public {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address account, address operator) public view returns (bool) {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) public {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not authorized");
        require(to != address(0), "Zero address");
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        _doSafeTransferAcceptanceCheck(msg.sender, from, to, id, amount, data);
    }

    function safeBatchTransferFrom(address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) public {
        require(from == msg.sender || isApprovedForAll(from, msg.sender), "Not authorized");
        require(ids.length == amounts.length, "Length mismatch");
        require(to != address(0), "Zero address");
        for (uint256 i = 0; i < ids.length; i++) {
            _balances[ids[i]][from] -= amounts[i];
            _balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        _doSafeBatchTransferAcceptanceCheck(msg.sender, from, to, ids, amounts, data);
    }

    function mint(address to, uint256 id, uint256 amount, bytes calldata data) public {
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, address(0), to, id, amount);
        _doSafeTransferAcceptanceCheck(msg.sender, address(0), to, id, amount, data);
    }

    function _doSafeTransferAcceptanceCheck(address operator, address from, address to, uint256 id, uint256 amount, bytes calldata data) private {
        if (to.code.length > 0) {
            bytes4 response = IERC1155Receiver(to).onERC1155Received(operator, from, id, amount, data);
            require(response == IERC1155Receiver.onERC1155Received.selector, "Non-ERC1155Receiver");
        }
    }

    function _doSafeBatchTransferAcceptanceCheck(address operator, address from, address to, uint256[] calldata ids, uint256[] calldata amounts, bytes calldata data) private {
        if (to.code.length > 0) {
            bytes4 response = IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ids, amounts, data);
            require(response == IERC1155Receiver.onERC1155BatchReceived.selector, "Non-ERC1155Receiver");
        }
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == 0xd9b67a26 || interfaceId == 0x0e89341c || interfaceId == 0x01ffc9a7;
    }
}`,
    },
    {
      prefix: 'erc4626',
      label: 'ERC4626 Tokenized Vault',
      description: 'ERC4626 tokenized vault standard with deposit/withdraw/redeem',
      category: 'Token Standards',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract \${1:TokenVault} {
    IERC20 public immutable asset;
    string public name = "\${2:Vault Token}";
    string public symbol = "\${3:vTKN}";
    uint8 public decimals = \${4:18};

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    constructor(IERC20 _asset) {
        asset = _asset;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? assets : (assets * supply) / totalAssets();
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? shares : (shares * totalAssets()) / supply;
    }

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        shares = convertToShares(assets);
        require(shares > 0, "Zero shares");
        asset.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) public returns (uint256 shares) {
        shares = convertToShares(assets);
        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max) {
                allowance[owner][msg.sender] = allowed - shares;
            }
        }
        _burn(owner, shares);
        asset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) public returns (uint256 assets) {
        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max) {
                allowance[owner][msg.sender] = allowed - shares;
            }
        }
        assets = convertToAssets(shares);
        require(assets > 0, "Zero assets");
        _burn(owner, shares);
        asset.transfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}`,
    },

    // -----------------------------------------------------------------------
    // Access Control
    // -----------------------------------------------------------------------
    {
      prefix: 'ownable',
      label: 'Ownable',
      description: 'Ownable pattern with onlyOwner modifier and ownership transfer',
      category: 'Access Control',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:OwnableContract} {
    address public owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function renounceOwnership() public onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    \${0:// Add your functions here}
}`,
    },
    {
      prefix: 'roles',
      label: 'Role-Based Access Control',
      description: 'Role-based access control with bytes32 roles, grant, revoke',
      category: 'Access Control',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:AccessControlled} {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant \${2:OPERATOR_ROLE} = keccak256("\${2:OPERATOR_ROLE}");

    mapping(bytes32 => mapping(address => bool)) private _roles;
    mapping(bytes32 => bytes32) private _roleAdmins;

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    error AccessControlUnauthorizedAccount(address account, bytes32 role);

    modifier onlyRole(bytes32 role) {
        if (!_roles[role][msg.sender]) revert AccessControlUnauthorizedAccount(msg.sender, role);
        _;
    }

    constructor() {
        _roles[ADMIN_ROLE][msg.sender] = true;
        emit RoleGranted(ADMIN_ROLE, msg.sender, msg.sender);
    }

    function hasRole(bytes32 role, address account) public view returns (bool) {
        return _roles[role][account];
    }

    function grantRole(bytes32 role, address account) public onlyRole(ADMIN_ROLE) {
        if (!_roles[role][account]) {
            _roles[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) public onlyRole(ADMIN_ROLE) {
        if (_roles[role][account]) {
            _roles[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }

    function renounceRole(bytes32 role) public {
        _roles[role][msg.sender] = false;
        emit RoleRevoked(role, msg.sender, msg.sender);
    }

    \${0:// Add your role-gated functions here}
}`,
    },
    {
      prefix: 'multisig',
      label: 'Multi-Signature Wallet',
      description: 'Basic multi-sig wallet requiring N-of-M approvals',
      category: 'Access Control',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:MultiSigWallet} {
    address[] public owners;
    uint256 public required;

    struct Transaction {
        address to;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    Transaction[] public transactions;
    mapping(address => bool) public isOwner;
    mapping(uint256 => mapping(address => bool)) public isConfirmed;

    event SubmitTransaction(uint256 indexed txId, address indexed to, uint256 value, bytes data);
    event ConfirmTransaction(uint256 indexed txId, address indexed owner);
    event RevokeConfirmation(uint256 indexed txId, address indexed owner);
    event ExecuteTransaction(uint256 indexed txId);

    error NotOwner();
    error TxNotFound();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error NotConfirmed();
    error ExecutionFailed();

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory _owners, uint256 _required) {
        require(_owners.length > 0, "Owners required");
        require(_required > 0 && _required <= _owners.length, "Invalid required count");
        for (uint256 i = 0; i < _owners.length; i++) {
            require(_owners[i] != address(0), "Invalid owner");
            require(!isOwner[_owners[i]], "Duplicate owner");
            isOwner[_owners[i]] = true;
            owners.push(_owners[i]);
        }
        required = _required;
    }

    function submit(address _to, uint256 _value, bytes calldata _data) external onlyOwner returns (uint256) {
        uint256 txId = transactions.length;
        transactions.push(Transaction({ to: _to, value: _value, data: _data, executed: false, confirmations: 0 }));
        emit SubmitTransaction(txId, _to, _value, _data);
        return txId;
    }

    function confirm(uint256 _txId) external onlyOwner {
        if (_txId >= transactions.length) revert TxNotFound();
        if (transactions[_txId].executed) revert AlreadyExecuted();
        if (isConfirmed[_txId][msg.sender]) revert AlreadyConfirmed();
        isConfirmed[_txId][msg.sender] = true;
        transactions[_txId].confirmations += 1;
        emit ConfirmTransaction(_txId, msg.sender);
    }

    function execute(uint256 _txId) external onlyOwner {
        Transaction storage txn = transactions[_txId];
        if (txn.executed) revert AlreadyExecuted();
        require(txn.confirmations >= required, "Not enough confirmations");
        txn.executed = true;
        (bool success, ) = txn.to.call{value: txn.value}(txn.data);
        if (!success) revert ExecutionFailed();
        emit ExecuteTransaction(_txId);
    }

    function revoke(uint256 _txId) external onlyOwner {
        if (!isConfirmed[_txId][msg.sender]) revert NotConfirmed();
        isConfirmed[_txId][msg.sender] = false;
        transactions[_txId].confirmations -= 1;
        emit RevokeConfirmation(_txId, msg.sender);
    }

    receive() external payable {}
}`,
    },
    {
      prefix: 'timelock',
      label: 'Timelock Controller',
      description: 'Timelock pattern for delayed execution of admin operations',
      category: 'Access Control',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:TimelockController} {
    uint256 public constant MIN_DELAY = \${2:1 days};
    uint256 public constant MAX_DELAY = \${3:30 days};

    address public admin;
    uint256 public delay;

    mapping(bytes32 => bool) public queued;

    event Queue(bytes32 indexed txId, address indexed target, uint256 value, bytes data, uint256 executeAt);
    event Execute(bytes32 indexed txId, address indexed target, uint256 value, bytes data);
    event Cancel(bytes32 indexed txId);
    event DelayUpdated(uint256 oldDelay, uint256 newDelay);

    error NotAdmin();
    error NotQueued();
    error AlreadyQueued();
    error TimestampNotPassed();
    error TimestampExpired();
    error ExecutionFailed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(uint256 _delay) {
        require(_delay >= MIN_DELAY && _delay <= MAX_DELAY, "Invalid delay");
        admin = msg.sender;
        delay = _delay;
    }

    function getTxId(address _target, uint256 _value, bytes calldata _data, uint256 _executeAt) public pure returns (bytes32) {
        return keccak256(abi.encode(_target, _value, _data, _executeAt));
    }

    function queue(address _target, uint256 _value, bytes calldata _data) external onlyAdmin returns (bytes32) {
        uint256 executeAt = block.timestamp + delay;
        bytes32 txId = getTxId(_target, _value, _data, executeAt);
        if (queued[txId]) revert AlreadyQueued();
        queued[txId] = true;
        emit Queue(txId, _target, _value, _data, executeAt);
        return txId;
    }

    function execute(address _target, uint256 _value, bytes calldata _data, uint256 _executeAt) external onlyAdmin {
        bytes32 txId = getTxId(_target, _value, _data, _executeAt);
        if (!queued[txId]) revert NotQueued();
        if (block.timestamp < _executeAt) revert TimestampNotPassed();
        if (block.timestamp > _executeAt + 14 days) revert TimestampExpired();
        queued[txId] = false;
        (bool success, ) = _target.call{value: _value}(_data);
        if (!success) revert ExecutionFailed();
        emit Execute(txId, _target, _value, _data);
    }

    function cancel(bytes32 _txId) external onlyAdmin {
        if (!queued[_txId]) revert NotQueued();
        queued[_txId] = false;
        emit Cancel(_txId);
    }

    function setDelay(uint256 _delay) external {
        require(msg.sender == address(this), "Only self");
        require(_delay >= MIN_DELAY && _delay <= MAX_DELAY, "Invalid delay");
        emit DelayUpdated(delay, _delay);
        delay = _delay;
    }

    receive() external payable {}
}`,
    },

    // -----------------------------------------------------------------------
    // DeFi Patterns
    // -----------------------------------------------------------------------
    {
      prefix: 'amm',
      label: 'Constant Product AMM',
      description: 'Constant product automated market maker (x*y=k)',
      category: 'DeFi Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract \${1:ConstantProductAMM} {
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;

    event Swap(address indexed sender, uint256 amountIn, uint256 amountOut, bool zeroForOne);
    event AddLiquidity(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity);
    event RemoveLiquidity(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity);

    constructor(address _token0, address _token1) {
        token0 = IERC20(_token0);
        token1 = IERC20(_token1);
    }

    function swap(address _tokenIn, uint256 _amountIn) external returns (uint256 amountOut) {
        require(_tokenIn == address(token0) || _tokenIn == address(token1), "Invalid token");
        require(_amountIn > 0, "Zero amount");

        bool isToken0 = _tokenIn == address(token0);
        (IERC20 tokenIn, IERC20 tokenOut, uint256 resIn, uint256 resOut) = isToken0
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        tokenIn.transferFrom(msg.sender, address(this), _amountIn);
        uint256 amountInWithFee = _amountIn * FEE_NUMERATOR;
        amountOut = (amountInWithFee * resOut) / (resIn * FEE_DENOMINATOR + amountInWithFee);
        tokenOut.transfer(msg.sender, amountOut);

        _updateReserves();
        emit Swap(msg.sender, _amountIn, amountOut, isToken0);
    }

    function addLiquidity(uint256 _amount0, uint256 _amount1) external returns (uint256 liquidity) {
        token0.transferFrom(msg.sender, address(this), _amount0);
        token1.transferFrom(msg.sender, address(this), _amount1);

        if (totalSupply == 0) {
            liquidity = _sqrt(_amount0 * _amount1);
        } else {
            liquidity = _min((_amount0 * totalSupply) / reserve0, (_amount1 * totalSupply) / reserve1);
        }
        require(liquidity > 0, "Zero liquidity");

        totalSupply += liquidity;
        balanceOf[msg.sender] += liquidity;
        _updateReserves();
        emit AddLiquidity(msg.sender, _amount0, _amount1, liquidity);
    }

    function removeLiquidity(uint256 _liquidity) external returns (uint256 amount0, uint256 amount1) {
        require(balanceOf[msg.sender] >= _liquidity, "Insufficient LP");
        amount0 = (_liquidity * reserve0) / totalSupply;
        amount1 = (_liquidity * reserve1) / totalSupply;
        require(amount0 > 0 && amount1 > 0, "Zero amounts");

        balanceOf[msg.sender] -= _liquidity;
        totalSupply -= _liquidity;
        token0.transfer(msg.sender, amount0);
        token1.transfer(msg.sender, amount1);
        _updateReserves();
        emit RemoveLiquidity(msg.sender, amount0, amount1, _liquidity);
    }

    function _updateReserves() private {
        reserve0 = token0.balanceOf(address(this));
        reserve1 = token1.balanceOf(address(this));
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) { z = x; x = (y / x + x) / 2; }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}`,
    },
    {
      prefix: 'staking',
      label: 'Staking / Rewards',
      description: 'Token staking contract with reward distribution',
      category: 'DeFi Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract \${1:StakingRewards} {
    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardsToken;
    address public owner;

    uint256 public rewardRate;
    uint256 public rewardPerTokenStored;
    uint256 public lastUpdateTime;
    uint256 public periodFinish;
    uint256 public totalStaked;

    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 duration);

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(address _stakingToken, address _rewardsToken) {
        stakingToken = IERC20(_stakingToken);
        rewardsToken = IERC20(_rewardsToken);
        owner = msg.sender;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return (stakedBalance[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function stake(uint256 amount) external updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        stakingToken.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        stakingToken.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claimReward() external updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.transfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    function notifyRewardAmount(uint256 reward, uint256 duration) external updateReward(address(0)) {
        require(msg.sender == owner, "Not owner");
        rewardRate = reward / duration;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, duration);
    }
}`,
    },
    {
      prefix: 'vault',
      label: 'Basic Vault',
      description: 'Simple vault pattern for depositing and withdrawing tokens',
      category: 'DeFi Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract \${1:Vault} {
    IERC20 public immutable token;
    mapping(address => uint256) public shares;
    uint256 public totalShares;

    event Deposit(address indexed user, uint256 amount, uint256 shares);
    event Withdraw(address indexed user, uint256 amount, uint256 shares);

    constructor(address _token) {
        token = IERC20(_token);
    }

    function deposit(uint256 amount) external returns (uint256 mintShares) {
        uint256 totalTokens = token.balanceOf(address(this));
        if (totalShares == 0) {
            mintShares = amount;
        } else {
            mintShares = (amount * totalShares) / totalTokens;
        }
        require(mintShares > 0, "Zero shares");
        shares[msg.sender] += mintShares;
        totalShares += mintShares;
        token.transferFrom(msg.sender, address(this), amount);
        emit Deposit(msg.sender, amount, mintShares);
    }

    function withdraw(uint256 _shares) external returns (uint256 amount) {
        require(shares[msg.sender] >= _shares, "Insufficient shares");
        uint256 totalTokens = token.balanceOf(address(this));
        amount = (_shares * totalTokens) / totalShares;
        shares[msg.sender] -= _shares;
        totalShares -= _shares;
        token.transfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount, _shares);
    }

    function sharePrice() external view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (token.balanceOf(address(this)) * 1e18) / totalShares;
    }
}`,
    },
    {
      prefix: 'flashloan',
      label: 'Flash Loan Receiver',
      description: 'Flash loan receiver contract pattern',
      category: 'DeFi Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IFlashLoanProvider {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external;
}

contract \${1:FlashLoanReceiver} {
    address public owner;

    event FlashLoanExecuted(address indexed token, uint256 amount, uint256 fee);

    error NotOwner();
    error NotLoanProvider();
    error InsufficientRepayment();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Called by the flash loan provider during the loan
    function executeOperation(
        address token,
        uint256 amount,
        uint256 fee,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // Verify this was initiated by us
        require(initiator == address(this), "Invalid initiator");

        // --- Your arbitrage/liquidation logic here ---
        \${0:// Use the borrowed funds}
        // --- End custom logic ---

        // Repay the loan + fee
        IERC20(token).transfer(msg.sender, amount + fee);
        emit FlashLoanExecuted(token, amount, fee);
        return true;
    }

    /// @notice Initiate a flash loan
    function requestFlashLoan(
        address provider,
        address token,
        uint256 amount,
        bytes calldata params
    ) external {
        if (msg.sender != owner) revert NotOwner();
        IFlashLoanProvider(provider).flashLoan(address(this), token, amount, params);
    }

    /// @notice Withdraw profits
    function withdraw(address token) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(owner, balance);
    }
}`,
    },
    {
      prefix: 'oracle',
      label: 'Chainlink Oracle Consumer',
      description: 'Chainlink price feed oracle consumer pattern',
      category: 'DeFi Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
}

contract \${1:OracleConsumer} {
    AggregatorV3Interface public immutable priceFeed;
    uint256 public constant STALE_THRESHOLD = \${2:3600}; // seconds

    error StalePrice();
    error InvalidPrice();

    constructor(address _priceFeed) {
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /// @notice Get the latest price with staleness check
    function getLatestPrice() public view returns (int256 price, uint8 decimals) {
        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = priceFeed.latestRoundData();

        if (answer <= 0) revert InvalidPrice();
        if (updatedAt == 0) revert InvalidPrice();
        if (block.timestamp - updatedAt > STALE_THRESHOLD) revert StalePrice();
        if (answeredInRound < roundId) revert StalePrice();

        return (answer, priceFeed.decimals());
    }

    /// @notice Convert amount to USD value (18 decimals)
    function getUsdValue(uint256 amount, uint8 tokenDecimals) public view returns (uint256) {
        (int256 price, uint8 priceDecimals) = getLatestPrice();
        return (amount * uint256(price) * 1e18) / (10 ** tokenDecimals * 10 ** priceDecimals);
    }

    \${0:// Add your price-dependent logic here}
}`,
    },

    // -----------------------------------------------------------------------
    // Security Patterns
    // -----------------------------------------------------------------------
    {
      prefix: 'reentrancyguard',
      label: 'Reentrancy Guard',
      description: 'ReentrancyGuard modifier to prevent reentrancy attacks',
      category: 'Security Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrancyGuardReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract \${1:SecureContract} is ReentrancyGuard {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
    }

    \${0:// Add your functions here}
}`,
    },
    {
      prefix: 'pausable',
      label: 'Pausable',
      description: 'Pausable pattern with pause/unpause emergency controls',
      category: 'Security Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:PausableContract} {
    address public owner;
    bool public paused;

    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();
    error NotOwner();

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    modifier whenPaused() {
        if (!paused) revert ExpectedPause();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner whenPaused {
        paused = false;
        emit Unpaused(msg.sender);
    }

    \${0:// Add your pausable functions with whenNotPaused modifier}
}`,
    },
    {
      prefix: 'pullpayment',
      label: 'Pull Payment (Escrow)',
      description: 'Pull payment pattern with escrow for safe fund distribution',
      category: 'Security Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:PullPayment} {
    mapping(address => uint256) private _deposits;

    event Deposited(address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);

    error NoFundsAvailable();
    error TransferFailed();

    /// @notice Check pending payment for an address
    function payments(address payee) public view returns (uint256) {
        return _deposits[payee];
    }

    /// @notice Withdraw accumulated payments (called by payee)
    function withdrawPayments() external {
        uint256 amount = _deposits[msg.sender];
        if (amount == 0) revert NoFundsAvailable();
        _deposits[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Credit a payee (internal — call from your business logic)
    function _asyncTransfer(address payee, uint256 amount) internal {
        _deposits[payee] += amount;
        emit Deposited(payee, amount);
    }

    \${0:// Use _asyncTransfer(recipient, amount) instead of direct transfers}
}`,
    },
    {
      prefix: 'ratelimit',
      label: 'Rate Limiting',
      description: 'Rate limiting modifier to throttle function calls',
      category: 'Security Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:RateLimited} {
    uint256 public constant RATE_LIMIT_PERIOD = \${2:1 hours};
    uint256 public constant MAX_CALLS_PER_PERIOD = \${3:10};

    struct RateLimit {
        uint256 windowStart;
        uint256 callCount;
    }

    mapping(address => RateLimit) private _rateLimits;

    error RateLimitExceeded(uint256 retryAfter);

    modifier rateLimited() {
        RateLimit storage rl = _rateLimits[msg.sender];
        if (block.timestamp >= rl.windowStart + RATE_LIMIT_PERIOD) {
            rl.windowStart = block.timestamp;
            rl.callCount = 0;
        }
        if (rl.callCount >= MAX_CALLS_PER_PERIOD) {
            revert RateLimitExceeded(rl.windowStart + RATE_LIMIT_PERIOD - block.timestamp);
        }
        rl.callCount++;
        _;
    }

    function getRemainingCalls(address user) external view returns (uint256) {
        RateLimit storage rl = _rateLimits[user];
        if (block.timestamp >= rl.windowStart + RATE_LIMIT_PERIOD) {
            return MAX_CALLS_PER_PERIOD;
        }
        if (rl.callCount >= MAX_CALLS_PER_PERIOD) return 0;
        return MAX_CALLS_PER_PERIOD - rl.callCount;
    }

    \${0:// Add rateLimited modifier to functions that need throttling}
}`,
    },

    // -----------------------------------------------------------------------
    // Proxy / Upgrade
    // -----------------------------------------------------------------------
    {
      prefix: 'proxy',
      label: 'Minimal Proxy (EIP-1167)',
      description: 'Minimal proxy clone factory using EIP-1167',
      category: 'Proxy/Upgrade',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:CloneFactory} {
    event CloneCreated(address indexed clone, address indexed implementation);

    /// @notice Deploy a minimal proxy (EIP-1167 clone)
    function clone(address implementation) public returns (address instance) {
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "Clone failed");
        emit CloneCreated(instance, implementation);
    }

    /// @notice Deploy a minimal proxy with CREATE2 for deterministic addresses
    function cloneDeterministic(address implementation, bytes32 salt) public returns (address instance) {
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create2(0, ptr, 0x37, salt)
        }
        require(instance != address(0), "Clone failed");
        emit CloneCreated(instance, implementation);
    }

    /// @notice Predict the address of a CREATE2 clone
    function predictDeterministicAddress(address implementation, bytes32 salt) public view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                implementation,
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash)))));
    }
}`,
    },
    {
      prefix: 'uups',
      label: 'UUPS Upgradeable',
      description: 'UUPS (Universal Upgradeable Proxy Standard) pattern',
      category: 'Proxy/Upgrade',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice UUPS Proxy contract
contract UUPSProxy {
    /// @dev EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
    bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation, bytes memory data) {
        assembly { sstore(_IMPLEMENTATION_SLOT, implementation) }
        if (data.length > 0) {
            (bool success, ) = implementation.delegatecall(data);
            require(success, "Init failed");
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(_IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}

/// @notice UUPS Upgradeable implementation base
abstract contract UUPSUpgradeable {
    bytes32 internal constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address private immutable __self = address(this);

    error OnlyProxy();
    error OnlyDelegateCall();

    modifier onlyProxy() {
        if (address(this) == __self) revert OnlyProxy();
        _;
    }

    function upgradeTo(address newImplementation) external virtual onlyProxy {
        _authorizeUpgrade(newImplementation);
        assembly { sstore(_IMPLEMENTATION_SLOT, newImplementation) }
    }

    function _authorizeUpgrade(address newImplementation) internal virtual;

    function proxiableUUID() external pure returns (bytes32) {
        return _IMPLEMENTATION_SLOT;
    }
}

contract \${1:MyUpgradeable} is UUPSUpgradeable {
    address public owner;
    uint256 public value;
    bool private initialized;

    function initialize(address _owner) external {
        require(!initialized, "Already initialized");
        initialized = true;
        owner = _owner;
    }

    function setValue(uint256 _value) external {
        require(msg.sender == owner, "Not owner");
        value = _value;
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == owner, "Not owner");
    }

    \${0:// Add your upgradeable logic here}
}`,
    },
    {
      prefix: 'transparent',
      label: 'Transparent Proxy',
      description: 'Transparent proxy pattern with admin slot',
      category: 'Proxy/Upgrade',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract \${1:TransparentProxy} {
    /// @dev EIP-1967 slots
    bytes32 private constant _IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant _ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    error ProxyDeniedAdminAccess();

    modifier ifAdmin() {
        if (msg.sender == _getAdmin()) {
            _;
        } else {
            _fallback();
        }
    }

    constructor(address implementation, address admin_, bytes memory data) {
        assembly { sstore(_ADMIN_SLOT, admin_) }
        assembly { sstore(_IMPLEMENTATION_SLOT, implementation) }
        if (data.length > 0) {
            (bool success, ) = implementation.delegatecall(data);
            require(success, "Init failed");
        }
    }

    function admin() external ifAdmin returns (address) {
        return _getAdmin();
    }

    function implementation() external ifAdmin returns (address) {
        return _getImplementation();
    }

    function upgradeTo(address newImplementation) external ifAdmin {
        assembly { sstore(_IMPLEMENTATION_SLOT, newImplementation) }
        emit Upgraded(newImplementation);
    }

    function changeAdmin(address newAdmin) external ifAdmin {
        emit AdminChanged(_getAdmin(), newAdmin);
        assembly { sstore(_ADMIN_SLOT, newAdmin) }
    }

    function _getAdmin() private view returns (address a) {
        assembly { a := sload(_ADMIN_SLOT) }
    }

    function _getImplementation() private view returns (address impl) {
        assembly { impl := sload(_IMPLEMENTATION_SLOT) }
    }

    function _fallback() private {
        assembly {
            let impl := sload(_IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    fallback() external payable {
        _fallback();
    }

    receive() external payable {
        _fallback();
    }
}`,
    },
    {
      prefix: 'diamond',
      label: 'Diamond (EIP-2535) Facet',
      description: 'Diamond pattern facet with storage slot pattern',
      category: 'Proxy/Upgrade',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Diamond storage library for a facet
library \${1:MyFacet}Storage {
    bytes32 constant STORAGE_POSITION = keccak256("diamond.storage.\${1:MyFacet}");

    struct Layout {
        uint256 value;
        mapping(address => uint256) balances;
        \${2:// Add your storage variables here}
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 position = STORAGE_POSITION;
        assembly { l.slot := position }
    }
}

/// @notice Diamond facet implementation
contract \${1:MyFacet} {
    event ValueUpdated(uint256 oldValue, uint256 newValue);

    function getValue() external view returns (uint256) {
        return \${1:MyFacet}Storage.layout().value;
    }

    function setValue(uint256 _value) external {
        \${1:MyFacet}Storage.Layout storage s = \${1:MyFacet}Storage.layout();
        uint256 old = s.value;
        s.value = _value;
        emit ValueUpdated(old, _value);
    }

    function getBalance(address account) external view returns (uint256) {
        return \${1:MyFacet}Storage.layout().balances[account];
    }

    \${0:// Add your facet functions here}
}

/// @notice IDiamondCut interface for reference
interface IDiamondCut {
    enum FacetCutAction { Add, Replace, Remove }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    function diamondCut(FacetCut[] calldata cuts, address init, bytes calldata data) external;
}`,
    },

    // -----------------------------------------------------------------------
    // Common Patterns
    // -----------------------------------------------------------------------
    {
      prefix: 'modifier',
      label: 'Custom Modifier',
      description: 'Custom modifier template with condition check',
      category: 'Common Patterns',
      body: `modifier \${1:onlyAuthorized}(\${2:address account}) {
    require(\${3:isAuthorized[account]}, "\${4:Not authorized}");
    _;
}`,
    },
    {
      prefix: 'event',
      label: 'Event Declaration',
      description: 'Event declaration with indexed parameters and emit',
      category: 'Common Patterns',
      body: `event \${1:ActionPerformed}(\${2:address indexed sender}, \${3:uint256 value});

// Emit the event:
emit \${1:ActionPerformed}(\${4:msg.sender}, \${5:amount});`,
    },
    {
      prefix: 'error',
      label: 'Custom Error',
      description: 'Custom error declaration (gas-efficient alternative to require strings)',
      category: 'Common Patterns',
      body: `error \${1:Unauthorized}(\${2:address caller});

// Usage:
if (\${3:msg.sender != owner}) revert \${1:Unauthorized}(\${4:msg.sender});`,
    },
    {
      prefix: 'struct',
      label: 'Struct with Mapping',
      description: 'Struct declaration with associated mapping',
      category: 'Common Patterns',
      body: `struct \${1:UserInfo} {
    uint256 \${2:amount};
    uint256 \${3:rewardDebt};
    uint256 \${4:lastUpdateTime};
    bool \${5:isActive};
}

mapping(\${6:address} => \${1:UserInfo}) public \${7:users};`,
    },
    {
      prefix: 'enum',
      label: 'Enum Declaration',
      description: 'Enum type declaration with usage example',
      category: 'Common Patterns',
      body: `enum \${1:Status} {
    \${2:Pending},
    \${3:Active},
    \${4:Completed},
    \${5:Cancelled}
}

\${1:Status} public currentStatus;

function setStatus(\${1:Status} _status) external {
    currentStatus = _status;
}`,
    },
    {
      prefix: 'interface',
      label: 'Interface Template',
      description: 'Solidity interface definition template',
      category: 'Common Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface I\${1:MyContract} {
    /// @notice \${2:Description of function}
    function \${3:myFunction}(\${4:uint256 value}) external \${5:returns (bool)};

    /// @notice Emitted when \${6:action occurs}
    event \${7:ActionPerformed}(address indexed sender, uint256 value);

    /// @notice Thrown when \${8:condition fails}
    error \${9:InvalidOperation}();
}`,
    },
    {
      prefix: 'library',
      label: 'Library Template',
      description: 'Solidity library with internal functions',
      category: 'Common Patterns',
      body: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library \${1:MathLib} {
    error \${2:Overflow}();

    /// @notice \${3:Safe addition with overflow check}
    function \${4:safeAdd}(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        if (c < a) revert \${2:Overflow}();
        return c;
    }

    \${0:// Add more library functions}
}

// Usage:
// using \${1:MathLib} for uint256;
// uint256 result = a.\${4:safeAdd}(b);`,
    },
    {
      prefix: 'receive',
      label: 'receive() and fallback()',
      description: 'receive and fallback functions for handling ETH transfers',
      category: 'Common Patterns',
      body: `/// @notice Accept ETH transfers
receive() external payable {
    emit Received(msg.sender, msg.value);
}

/// @notice Fallback for non-matching function calls
fallback() external payable {
    \${1:revert("Function not found");}
}

event Received(address indexed sender, uint256 amount);`,
    },
    {
      prefix: 'constructor',
      label: 'Constructor with Initializer',
      description: 'Constructor pattern with parameter validation',
      category: 'Common Patterns',
      body: `address public immutable \${1:admin};
uint256 public \${2:fee};
bool private _initialized;

constructor(address _\${1:admin}, uint256 _\${2:fee}) {
    require(_\${1:admin} != address(0), "Zero address");
    require(_\${2:fee} <= \${3:10000}, "Fee too high");
    \${1:admin} = _\${1:admin};
    \${2:fee} = _\${2:fee};
}

/// @notice One-time initialization (for proxy-deployed contracts)
function initialize(address _\${1:admin}, uint256 _\${2:fee}) external {
    require(!_initialized, "Already initialized");
    _initialized = true;
    // Note: cannot set immutable vars in initializer
}`,
    },
    {
      prefix: 'mapping',
      label: 'Nested Mapping Pattern',
      description: 'Nested mapping with getter and setter functions',
      category: 'Common Patterns',
      body: `/// @dev \${1:owner} => \${2:spender} => \${3:amount}
mapping(\${4:address} => mapping(\${5:address} => \${6:uint256})) private _\${7:allowances};

function get\${8:Allowance}(\${4:address} \${1:owner}, \${5:address} \${2:spender}) public view returns (\${6:uint256}) {
    return _\${7:allowances}[\${1:owner}][\${2:spender}];
}

function set\${8:Allowance}(\${5:address} \${2:spender}, \${6:uint256} \${3:amount}) public {
    _\${7:allowances}[msg.sender][\${2:spender}] = \${3:amount};
}`,
    },

    // -----------------------------------------------------------------------
    // Gas Optimization
    // -----------------------------------------------------------------------
    {
      prefix: 'immutable',
      label: 'Immutable Variable Pattern',
      description: 'Gas-efficient immutable variables set in constructor',
      category: 'Gas Optimization',
      body: `/// @notice Immutable variables are stored in bytecode, saving ~2100 gas per read vs storage
address public immutable \${1:FACTORY};
uint256 public immutable \${2:CREATION_BLOCK};
bytes32 public immutable \${3:DOMAIN_SEPARATOR};

constructor(address _factory) {
    \${1:FACTORY} = _factory;
    \${2:CREATION_BLOCK} = block.number;
    \${3:DOMAIN_SEPARATOR} = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("\${4:MyContract}")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        )
    );
}`,
    },
    {
      prefix: 'calldata',
      label: 'Calldata vs Memory',
      description: 'Use calldata instead of memory for read-only external function parameters',
      category: 'Gas Optimization',
      body: `/// @notice Using calldata saves gas by avoiding memory copy
/// Gas savings: ~60 gas per argument for simple types, more for arrays/structs
function processData(
    bytes calldata data,
    uint256[] calldata values,
    string calldata name
) external pure returns (bytes32) {
    // calldata variables are read-only — cannot be modified
    return keccak256(abi.encodePacked(data, name));
}

/// @notice Use memory only when you need to modify the parameter
function processAndModify(
    uint256[] memory values
) public pure returns (uint256) {
    // Can modify memory arrays
    values[0] = values[0] * 2;
    uint256 sum;
    for (uint256 i; i < values.length;) {
        sum += values[i];
        unchecked { ++i; }
    }
    return sum;
}`,
    },
    {
      prefix: 'unchecked',
      label: 'Unchecked Arithmetic',
      description: 'Unchecked block for gas-efficient arithmetic where overflow is impossible',
      category: 'Gas Optimization',
      body: `/// @notice Unchecked arithmetic saves ~100-150 gas per operation
/// ONLY use when overflow/underflow is mathematically impossible

// Safe: loop counter cannot overflow uint256
for (uint256 i; i < \${1:length};) {
    \${2:// loop body}
    unchecked { ++i; } // saves ~80 gas vs checked increment
}

// Safe: subtraction after >= check
function safeSub(uint256 a, uint256 b) internal pure returns (uint256) {
    require(a >= b, "Underflow");
    unchecked { return a - b; }
}

// Safe: ratio computation where denominator != 0
function computeShare(uint256 amount, uint256 total) internal pure returns (uint256) {
    if (total == 0) return 0;
    unchecked { return (amount * 1e18) / total; }
}`,
    },
    {
      prefix: 'assembly',
      label: 'Inline Assembly Block',
      description: 'Yul inline assembly for low-level gas optimization',
      category: 'Gas Optimization',
      body: `/// @notice Efficient address zero check using assembly (~6 gas vs Solidity's ~20)
function isZeroAddress(address addr) internal pure returns (bool result) {
    assembly {
        result := iszero(addr)
    }
}

/// @notice Efficient balance read from storage slot
function getStorageAt(bytes32 slot) internal view returns (bytes32 value) {
    assembly {
        value := sload(slot)
    }
}

/// @notice Gas-efficient ETH transfer
function safeTransferETH(address to, uint256 amount) internal {
    assembly {
        let success := call(gas(), to, amount, 0, 0, 0, 0)
        if iszero(success) {
            // Revert with "TransferFailed()"
            mstore(0x00, 0x90b8ec18)
            revert(0x1c, 0x04)
        }
    }
}

\${0:// Add your assembly blocks here}`,
    },
    {
      prefix: 'bitmap',
      label: 'Bitmap Storage',
      description: 'Gas-efficient bitmap for boolean storage (256 bools per slot)',
      category: 'Gas Optimization',
      body: `/// @notice Store 256 booleans per storage slot using a bitmap
/// Saves ~20,000 gas compared to mapping(uint256 => bool)
mapping(uint256 => uint256) private _bitmap;

/// @notice Check if bit at index is set
function isSet(uint256 index) public view returns (bool) {
    uint256 bucket = index >> 8;      // index / 256
    uint256 bit = index & 0xff;       // index % 256
    return (_bitmap[bucket] >> bit) & 1 == 1;
}

/// @notice Set bit at index
function set(uint256 index) public {
    uint256 bucket = index >> 8;
    uint256 bit = index & 0xff;
    _bitmap[bucket] |= (1 << bit);
}

/// @notice Clear bit at index
function clear(uint256 index) public {
    uint256 bucket = index >> 8;
    uint256 bit = index & 0xff;
    _bitmap[bucket] &= ~(1 << bit);
}

/// @notice Toggle bit at index
function toggle(uint256 index) public {
    uint256 bucket = index >> 8;
    uint256 bit = index & 0xff;
    _bitmap[bucket] ^= (1 << bit);
}`,
    },
    {
      prefix: 'packed',
      label: 'Struct Packing',
      description: 'Struct packing for storage optimization (fits in fewer slots)',
      category: 'Gas Optimization',
      body: `/// @notice UNPACKED: Uses 4 storage slots (128 bytes)
/// Each variable occupies its own 32-byte slot
struct UnpackedData {
    uint256 amount;     // slot 0 (32 bytes)
    address owner;      // slot 1 (20 bytes, but uses full slot)
    uint64 timestamp;   // slot 2 (8 bytes, but uses full slot)
    bool isActive;      // slot 3 (1 byte, but uses full slot)
}

/// @notice PACKED: Uses 2 storage slots (64 bytes)
/// Variables ordered by size to pack into fewer slots
struct PackedData {
    uint256 amount;     // slot 0 (32 bytes) - full slot
    address owner;      // slot 1 (20 bytes) --|
    uint64 timestamp;   //         (8 bytes)  --|- packed into slot 1
    bool isActive;      //         (1 byte)   --|  (29 bytes total)
}

/// @notice Save ~4200 gas per SSTORE by packing
PackedData public data;

function updatePacked(uint256 _amount, address _owner, uint64 _ts) external {
    // Single SSTORE for owner + timestamp + isActive
    data = PackedData({
        amount: _amount,
        owner: _owner,
        timestamp: _ts,
        isActive: true
    });
}`,
    },
  ];
}
