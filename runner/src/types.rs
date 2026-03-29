use alloy_json_abi::JsonAbi;
use serde::Serialize;

/// Top-level output for one contract.
#[derive(Debug, Serialize)]
pub struct ContractReport {
    pub contract: String,
    pub functions: Vec<FunctionReport>,
}

/// Per-function gas execution report.
#[derive(Debug, Serialize)]
pub struct FunctionReport {
    pub name: String,
    pub selector: String,
    pub signature: String,
    pub gas: u64,
    pub status: ExecutionStatus,
    /// Which calldata strategy produced this result.
    /// Omitted from JSON when None for backward compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
}

/// Whether the function call succeeded or reverted.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Success,
    Revert,
    Halt,
}

/// Intermediate representation of a compiled contract.
#[derive(Debug)]
pub struct CompiledContract {
    pub name: String,
    pub abi: JsonAbi,
    pub bytecode: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Storage layout types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct StorageSlot {
    pub slot: u64,
    pub offset: usize,
    pub access: String,
}

#[derive(Debug, Serialize)]
pub struct StorageLayoutReport {
    pub contract: String,
    pub slots: Vec<StorageSlot>,
}

// ---------------------------------------------------------------------------
// Control flow graph types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct BasicBlock {
    pub id: usize,
    pub start: usize,
    pub end: usize,
    pub successors: Vec<usize>,
    pub opcodes: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CfgReport {
    pub contract: String,
    pub blocks: Vec<BasicBlock>,
}

// ---------------------------------------------------------------------------
// Call graph types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct CallEdge {
    pub from_function: String,
    pub to_address: String,
    pub call_type: String,
    pub offset: usize,
}

#[derive(Debug, Serialize)]
pub struct CallGraphReport {
    pub contract: String,
    pub edges: Vec<CallEdge>,
}

// ---------------------------------------------------------------------------
// ABI decode types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct DecodedValue {
    pub type_name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct AbiDecodeResult {
    pub selector: Option<String>,
    pub function: Option<String>,
    pub values: Vec<DecodedValue>,
}

// ---------------------------------------------------------------------------
// Signature database types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SignatureMatch {
    pub selector: String,
    pub signatures: Vec<String>,
}

// ---------------------------------------------------------------------------
// Fuzzer types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct FuzzResult {
    pub function: String,
    pub selector: String,
    pub rounds: u32,
    pub successes: u32,
    pub reverts: u32,
    pub halts: u32,
    pub min_gas: u64,
    pub max_gas: u64,
    pub avg_gas: u64,
}

#[derive(Debug, Serialize)]
pub struct FuzzReport {
    pub contract: String,
    pub results: Vec<FuzzResult>,
}
