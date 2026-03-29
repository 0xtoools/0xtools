use crate::types::{BasicBlock, CfgReport, CompiledContract};
use std::collections::{BTreeSet, HashMap};

// Opcodes that terminate a basic block
const OP_STOP: u8 = 0x00;
const OP_JUMP: u8 = 0x56;
const OP_JUMPI: u8 = 0x57;
const OP_JUMPDEST: u8 = 0x5b;
const OP_RETURN: u8 = 0xf3;
const OP_REVERT: u8 = 0xfd;
const OP_INVALID: u8 = 0xfe;
const OP_SELFDESTRUCT: u8 = 0xff;

const OP_PUSH1: u8 = 0x60;
const OP_PUSH32: u8 = 0x7f;

/// Build a control flow graph from EVM bytecode for each compiled contract.
pub fn build_cfg(contracts: &[CompiledContract]) -> Vec<CfgReport> {
    contracts
        .iter()
        .map(|c| CfgReport {
            contract: c.name.clone(),
            blocks: build_cfg_for_bytecode(&c.bytecode),
        })
        .collect()
}

fn build_cfg_for_bytecode(bytecode: &[u8]) -> Vec<BasicBlock> {
    if bytecode.is_empty() {
        return Vec::new();
    }

    // Step 1: Parse opcodes and find all JUMPDEST positions + block boundaries
    let ops = parse_ops(bytecode);
    let _jumpdest_set = find_jumpdests(&ops);

    // Step 2: Identify basic block boundaries
    // A new block starts at:
    //   - offset 0
    //   - every JUMPDEST
    //   - the instruction after a JUMP, JUMPI, STOP, RETURN, REVERT, INVALID, SELFDESTRUCT
    let mut block_starts: BTreeSet<usize> = BTreeSet::new();
    block_starts.insert(0);

    for &(offset, opcode) in &ops {
        if opcode == OP_JUMPDEST {
            block_starts.insert(offset);
        }
    }

    for (i, &(_, opcode)) in ops.iter().enumerate() {
        if is_block_terminator(opcode) {
            // The next instruction (if any) starts a new block
            if i + 1 < ops.len() {
                block_starts.insert(ops[i + 1].0);
            }
        }
    }

    // Step 3: Build blocks
    let starts: Vec<usize> = block_starts.iter().copied().collect();
    // Map from start offset -> block id
    let start_to_id: HashMap<usize, usize> = starts
        .iter()
        .enumerate()
        .map(|(id, &start)| (start, id))
        .collect();

    // For each block, collect its opcode range and the opcodes within it
    let mut blocks: Vec<BasicBlock> = Vec::new();

    for (block_idx, &block_start) in starts.iter().enumerate() {
        let block_end_exclusive = if block_idx + 1 < starts.len() {
            starts[block_idx + 1]
        } else {
            bytecode.len()
        };

        // Collect opcodes in this block
        let block_ops: Vec<&(usize, u8)> = ops
            .iter()
            .filter(|(off, _)| *off >= block_start && *off < block_end_exclusive)
            .collect();

        let opcode_names: Vec<String> = block_ops
            .iter()
            .map(|(off, op)| format_opcode(*off, *op, bytecode))
            .collect();

        let last_op = block_ops.last().map(|(_, op)| *op);

        // Determine successors
        let mut successors: Vec<usize> = Vec::new();

        match last_op {
            Some(OP_JUMP) => {
                // Unconditional jump — successor is the PUSH target (if determinable)
                if let Some(target) = find_push_target(&block_ops, bytecode) {
                    if let Some(&target_id) = start_to_id.get(&(target as usize)) {
                        successors.push(target_id);
                    }
                }
            }
            Some(OP_JUMPI) => {
                // Conditional jump — two successors: fall-through and jump target
                // Fall-through
                if block_idx + 1 < starts.len() {
                    successors.push(block_idx + 1);
                }
                // Jump target from PUSH before the condition
                if let Some(target) = find_push_target_for_jumpi(&block_ops, bytecode) {
                    if let Some(&target_id) = start_to_id.get(&(target as usize)) {
                        if !successors.contains(&target_id) {
                            successors.push(target_id);
                        }
                    }
                }
            }
            Some(OP_STOP) | Some(OP_RETURN) | Some(OP_REVERT) | Some(OP_INVALID)
            | Some(OP_SELFDESTRUCT) => {
                // Terminal — no successors
            }
            _ => {
                // Fall-through to next block
                if block_idx + 1 < starts.len() {
                    successors.push(block_idx + 1);
                }
            }
        }

        blocks.push(BasicBlock {
            id: block_idx,
            start: block_start,
            end: block_end_exclusive.saturating_sub(1),
            successors,
            opcodes: opcode_names,
        });
    }

    blocks
}

fn is_block_terminator(opcode: u8) -> bool {
    matches!(
        opcode,
        OP_STOP | OP_JUMP | OP_JUMPI | OP_RETURN | OP_REVERT | OP_INVALID | OP_SELFDESTRUCT
    )
}

/// Parse bytecode into (offset, opcode) pairs, skipping PUSH data.
fn parse_ops(bytecode: &[u8]) -> Vec<(usize, u8)> {
    let mut ops = Vec::new();
    let mut i = 0;
    while i < bytecode.len() {
        let opcode = bytecode[i];
        ops.push((i, opcode));
        if opcode >= OP_PUSH1 && opcode <= OP_PUSH32 {
            let push_size = (opcode - OP_PUSH1 + 1) as usize;
            i += 1 + push_size;
        } else {
            i += 1;
        }
    }
    ops
}

/// Find all JUMPDEST offsets in the bytecode.
fn find_jumpdests(ops: &[(usize, u8)]) -> BTreeSet<usize> {
    ops.iter()
        .filter(|(_, op)| *op == OP_JUMPDEST)
        .map(|(off, _)| *off)
        .collect()
}

/// For a JUMP instruction at the end of a block, try to find the pushed target.
/// The target is typically the value pushed by the instruction immediately before JUMP.
fn find_push_target(block_ops: &[&(usize, u8)], bytecode: &[u8]) -> Option<u64> {
    if block_ops.len() < 2 {
        return None;
    }
    let second_last = block_ops[block_ops.len() - 2];
    extract_push_value(second_last.0, second_last.1, bytecode)
}

/// For a JUMPI instruction, the stack has [condition, target].
/// The target is pushed before the condition, so we look at the instruction
/// 2 positions before JUMPI if possible. But often the pattern is:
///   PUSH target, <condition_computation>, JUMPI
/// This is hard to determine statically, so we look for the nearest PUSH
/// that could be a JUMPDEST target.
fn find_push_target_for_jumpi(block_ops: &[&(usize, u8)], bytecode: &[u8]) -> Option<u64> {
    // Walk backwards from the JUMPI looking for PUSHes that could be jump targets
    for i in (0..block_ops.len().saturating_sub(1)).rev() {
        let (off, op) = *block_ops[i];
        if op >= OP_PUSH1 && op <= OP_PUSH32 {
            if let Some(val) = extract_push_value(off, op, bytecode) {
                // Check if this value points to a JUMPDEST
                let target = val as usize;
                if target < bytecode.len() && bytecode[target] == OP_JUMPDEST {
                    return Some(val);
                }
            }
        }
    }
    None
}

/// Extract the value of a PUSH instruction.
fn extract_push_value(offset: usize, opcode: u8, bytecode: &[u8]) -> Option<u64> {
    if opcode < OP_PUSH1 || opcode > OP_PUSH32 {
        return None;
    }
    let push_size = (opcode - OP_PUSH1 + 1) as usize;
    let data_start = offset + 1;
    let data_end = data_start + push_size;
    if data_end > bytecode.len() {
        return None;
    }
    let mut val: u64 = 0;
    for &b in &bytecode[data_start..data_end] {
        val = val.saturating_mul(256).saturating_add(b as u64);
    }
    Some(val)
}

/// Format an opcode with its offset and mnemonic for human-readable output.
fn format_opcode(offset: usize, opcode: u8, bytecode: &[u8]) -> String {
    let name = opcode_name(opcode);
    if opcode >= OP_PUSH1 && opcode <= OP_PUSH32 {
        let push_size = (opcode - OP_PUSH1 + 1) as usize;
        let data_start = offset + 1;
        let data_end = (data_start + push_size).min(bytecode.len());
        let hex_data = hex::encode(&bytecode[data_start..data_end]);
        format!("{offset:#06x}: {name} 0x{hex_data}")
    } else {
        format!("{offset:#06x}: {name}")
    }
}

/// Map an opcode byte to its mnemonic.
fn opcode_name(opcode: u8) -> &'static str {
    match opcode {
        0x00 => "STOP",
        0x01 => "ADD",
        0x02 => "MUL",
        0x03 => "SUB",
        0x04 => "DIV",
        0x05 => "SDIV",
        0x06 => "MOD",
        0x07 => "SMOD",
        0x08 => "ADDMOD",
        0x09 => "MULMOD",
        0x0a => "EXP",
        0x0b => "SIGNEXTEND",
        0x10 => "LT",
        0x11 => "GT",
        0x12 => "SLT",
        0x13 => "SGT",
        0x14 => "EQ",
        0x15 => "ISZERO",
        0x16 => "AND",
        0x17 => "OR",
        0x18 => "XOR",
        0x19 => "NOT",
        0x1a => "BYTE",
        0x1b => "SHL",
        0x1c => "SHR",
        0x1d => "SAR",
        0x20 => "SHA3",
        0x30 => "ADDRESS",
        0x31 => "BALANCE",
        0x32 => "ORIGIN",
        0x33 => "CALLER",
        0x34 => "CALLVALUE",
        0x35 => "CALLDATALOAD",
        0x36 => "CALLDATASIZE",
        0x37 => "CALLDATACOPY",
        0x38 => "CODESIZE",
        0x39 => "CODECOPY",
        0x3a => "GASPRICE",
        0x3b => "EXTCODESIZE",
        0x3c => "EXTCODECOPY",
        0x3d => "RETURNDATASIZE",
        0x3e => "RETURNDATACOPY",
        0x3f => "EXTCODEHASH",
        0x40 => "BLOCKHASH",
        0x41 => "COINBASE",
        0x42 => "TIMESTAMP",
        0x43 => "NUMBER",
        0x44 => "DIFFICULTY",
        0x45 => "GASLIMIT",
        0x46 => "CHAINID",
        0x47 => "SELFBALANCE",
        0x48 => "BASEFEE",
        0x50 => "POP",
        0x51 => "MLOAD",
        0x52 => "MSTORE",
        0x53 => "MSTORE8",
        0x54 => "SLOAD",
        0x55 => "SSTORE",
        0x56 => "JUMP",
        0x57 => "JUMPI",
        0x58 => "PC",
        0x59 => "MSIZE",
        0x5a => "GAS",
        0x5b => "JUMPDEST",
        0x5f => "PUSH0",
        0x60..=0x7f => {
            // PUSH1..PUSH32
            // We can't return a dynamically formatted string from a static str,
            // but we can use a lookup table for the common ones
            match opcode {
                0x60 => "PUSH1",
                0x61 => "PUSH2",
                0x62 => "PUSH3",
                0x63 => "PUSH4",
                0x64 => "PUSH5",
                0x65 => "PUSH6",
                0x66 => "PUSH7",
                0x67 => "PUSH8",
                0x68 => "PUSH9",
                0x69 => "PUSH10",
                0x6a => "PUSH11",
                0x6b => "PUSH12",
                0x6c => "PUSH13",
                0x6d => "PUSH14",
                0x6e => "PUSH15",
                0x6f => "PUSH16",
                0x70 => "PUSH17",
                0x71 => "PUSH18",
                0x72 => "PUSH19",
                0x73 => "PUSH20",
                0x74 => "PUSH21",
                0x75 => "PUSH22",
                0x76 => "PUSH23",
                0x77 => "PUSH24",
                0x78 => "PUSH25",
                0x79 => "PUSH26",
                0x7a => "PUSH27",
                0x7b => "PUSH28",
                0x7c => "PUSH29",
                0x7d => "PUSH30",
                0x7e => "PUSH31",
                0x7f => "PUSH32",
                _ => "PUSH?",
            }
        }
        0x80 => "DUP1",
        0x81 => "DUP2",
        0x82 => "DUP3",
        0x83 => "DUP4",
        0x84 => "DUP5",
        0x85 => "DUP6",
        0x86 => "DUP7",
        0x87 => "DUP8",
        0x88 => "DUP9",
        0x89 => "DUP10",
        0x8a => "DUP11",
        0x8b => "DUP12",
        0x8c => "DUP13",
        0x8d => "DUP14",
        0x8e => "DUP15",
        0x8f => "DUP16",
        0x90 => "SWAP1",
        0x91 => "SWAP2",
        0x92 => "SWAP3",
        0x93 => "SWAP4",
        0x94 => "SWAP5",
        0x95 => "SWAP6",
        0x96 => "SWAP7",
        0x97 => "SWAP8",
        0x98 => "SWAP9",
        0x99 => "SWAP10",
        0x9a => "SWAP11",
        0x9b => "SWAP12",
        0x9c => "SWAP13",
        0x9d => "SWAP14",
        0x9e => "SWAP15",
        0x9f => "SWAP16",
        0xa0 => "LOG0",
        0xa1 => "LOG1",
        0xa2 => "LOG2",
        0xa3 => "LOG3",
        0xa4 => "LOG4",
        0xf0 => "CREATE",
        0xf1 => "CALL",
        0xf2 => "CALLCODE",
        0xf3 => "RETURN",
        0xf4 => "DELEGATECALL",
        0xf5 => "CREATE2",
        0xfa => "STATICCALL",
        0xfd => "REVERT",
        0xfe => "INVALID",
        0xff => "SELFDESTRUCT",
        _ => "UNKNOWN",
    }
}
