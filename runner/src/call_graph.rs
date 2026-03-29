use crate::types::{CallEdge, CallGraphReport, CompiledContract};

// Call-type opcodes
const OP_CALL: u8 = 0xf1;
const OP_CALLCODE: u8 = 0xf2;
const OP_DELEGATECALL: u8 = 0xf4;
const OP_STATICCALL: u8 = 0xfa;

// PUSH range
const OP_PUSH1: u8 = 0x60;
const OP_PUSH4: u8 = 0x63;
const OP_PUSH20: u8 = 0x73;
const OP_PUSH32: u8 = 0x7f;

// Function dispatch opcodes
const OP_EQ: u8 = 0x14;
const OP_JUMPI: u8 = 0x57;

/// Analyze bytecode for inter-contract calls and function dispatch patterns.
pub fn build_call_graph(contracts: &[CompiledContract]) -> Vec<CallGraphReport> {
    contracts
        .iter()
        .map(|c| {
            let selectors = extract_function_selectors(&c.bytecode);
            let edges = analyze_calls(&c.bytecode, &selectors);
            CallGraphReport {
                contract: c.name.clone(),
                edges,
            }
        })
        .collect()
}

/// A detected function region in bytecode (selector -> offset range).
struct FunctionRegion {
    selector: String,
    start: usize,
}

/// Extract function selectors from the bytecode dispatch table.
/// Solidity compilers emit a pattern like:
///   PUSH4 <selector>  DUP2  EQ  PUSH2 <jumpdest>  JUMPI
fn extract_function_selectors(bytecode: &[u8]) -> Vec<FunctionRegion> {
    let ops = parse_ops(bytecode);
    let mut regions = Vec::new();

    for (i, &(offset, opcode)) in ops.iter().enumerate() {
        // Look for PUSH4 followed eventually by EQ and JUMPI
        if opcode != OP_PUSH4 {
            continue;
        }
        let push_size = 4;
        let data_start = offset + 1;
        let data_end = data_start + push_size;
        if data_end > bytecode.len() {
            continue;
        }
        let selector = format!("0x{}", hex::encode(&bytecode[data_start..data_end]));

        // Look ahead (up to 10 ops) for an EQ followed by JUMPI
        let window = (i + 1)..(i + 11).min(ops.len());
        let mut found_eq = false;
        let mut jump_target: Option<usize> = None;

        for j in window {
            let (_, op) = ops[j];
            if op == OP_EQ {
                found_eq = true;
            }
            if found_eq && op == OP_JUMPI {
                // Look for a PUSH before JUMPI that gives us the jump target
                if j >= 1 {
                    let (prev_off, prev_op) = ops[j - 1];
                    if prev_op >= OP_PUSH1 && prev_op <= OP_PUSH32 {
                        if let Some(target) = extract_push_value(prev_off, prev_op, bytecode) {
                            jump_target = Some(target as usize);
                        }
                    }
                }
                break;
            }
        }

        if found_eq {
            regions.push(FunctionRegion {
                selector,
                start: jump_target.unwrap_or(offset),
            });
        }
    }

    regions
}

/// Analyze bytecode for CALL, STATICCALL, DELEGATECALL opcodes and build call edges.
fn analyze_calls(bytecode: &[u8], selectors: &[FunctionRegion]) -> Vec<CallEdge> {
    let ops = parse_ops(bytecode);
    let mut edges = Vec::new();

    for (i, &(offset, opcode)) in ops.iter().enumerate() {
        let call_type = match opcode {
            OP_CALL => "call",
            OP_CALLCODE => "callcode",
            OP_DELEGATECALL => "delegatecall",
            OP_STATICCALL => "staticcall",
            _ => continue,
        };

        // Try to find an address pushed before this CALL.
        // For CALL: stack is [gas, addr, value, argsOffset, argsLength, retOffset, retLength]
        // For STATICCALL/DELEGATECALL: [gas, addr, argsOffset, argsLength, retOffset, retLength]
        // We scan backwards looking for PUSH20 (address literal)
        let to_address = find_address_before(&ops, i, bytecode);

        // Determine which function this call belongs to
        let from_function = find_enclosing_function(offset, selectors);

        edges.push(CallEdge {
            from_function,
            to_address: to_address.unwrap_or_else(|| "dynamic".to_string()),
            call_type: call_type.to_string(),
            offset,
        });
    }

    edges
}

/// Scan backwards from a CALL opcode looking for a PUSH20 that could be the target address.
fn find_address_before(ops: &[(usize, u8)], call_idx: usize, bytecode: &[u8]) -> Option<String> {
    let search_start = call_idx.saturating_sub(20);
    for j in (search_start..call_idx).rev() {
        let (off, op) = ops[j];
        if op == OP_PUSH20 {
            let data_start = off + 1;
            let data_end = data_start + 20;
            if data_end <= bytecode.len() {
                let addr_bytes = &bytecode[data_start..data_end];
                // Skip zero addresses (likely not real targets)
                if addr_bytes.iter().any(|&b| b != 0) {
                    return Some(format!("0x{}", hex::encode(addr_bytes)));
                }
            }
        }
    }
    None
}

/// Find which function selector region contains the given offset.
fn find_enclosing_function(offset: usize, selectors: &[FunctionRegion]) -> String {
    // Find the function with the largest start that's still <= offset
    let mut best: Option<&FunctionRegion> = None;
    for region in selectors {
        if region.start <= offset {
            match best {
                None => best = Some(region),
                Some(b) if region.start > b.start => best = Some(region),
                _ => {}
            }
        }
    }
    best.map(|r| r.selector.clone())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Parse bytecode into (offset, opcode) pairs.
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

/// Extract the numeric value of a PUSH instruction.
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
