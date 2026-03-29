use crate::types::{CompiledContract, StorageLayoutReport, StorageSlot};
use std::collections::HashMap;

/// EVM opcodes relevant to storage analysis.
const OP_SLOAD: u8 = 0x54;
const OP_SSTORE: u8 = 0x55;

/// PUSH1..PUSH32 range.
const OP_PUSH1: u8 = 0x60;
const OP_PUSH32: u8 = 0x7f;

/// Analyze compiled bytecode to find SSTORE/SLOAD patterns and map storage slots.
///
/// Walk through the bytecode looking for SLOAD and SSTORE opcodes. When we find
/// one, examine the preceding instruction — if it's a PUSH, we can determine
/// which storage slot is being accessed. We then aggregate by slot number and
/// record whether it's read, written, or both.
pub fn analyze_storage(contracts: &[CompiledContract]) -> Vec<StorageLayoutReport> {
    contracts
        .iter()
        .map(|c| StorageLayoutReport {
            contract: c.name.clone(),
            slots: analyze_bytecode(&c.bytecode),
        })
        .collect()
}

fn analyze_bytecode(bytecode: &[u8]) -> Vec<StorageSlot> {
    // Map from slot number -> (first_offset, read, write)
    let mut slot_map: HashMap<u64, (usize, bool, bool)> = HashMap::new();

    // First pass: collect all (offset, opcode) pairs, skipping PUSH data bytes
    let ops = parse_opcodes(bytecode);

    // Second pass: look for SLOAD/SSTORE preceded by a PUSH
    for (i, &(offset, opcode)) in ops.iter().enumerate() {
        if opcode != OP_SLOAD && opcode != OP_SSTORE {
            continue;
        }

        // Look for a PUSH immediately before this opcode
        if i == 0 {
            continue;
        }
        let (prev_offset, prev_opcode) = ops[i - 1];
        if prev_opcode < OP_PUSH1 || prev_opcode > OP_PUSH32 {
            continue;
        }

        // Extract the pushed value as a slot number
        let push_size = (prev_opcode - OP_PUSH1 + 1) as usize;
        let data_start = prev_offset + 1;
        let data_end = data_start + push_size;
        if data_end > bytecode.len() {
            continue;
        }
        let slot = bytes_to_u64(&bytecode[data_start..data_end]);

        let entry = slot_map.entry(slot).or_insert((offset, false, false));
        if opcode == OP_SLOAD {
            entry.1 = true;
        } else {
            entry.2 = true;
        }
    }

    // Sort by slot number for deterministic output
    let mut slots: Vec<(u64, usize, bool, bool)> = slot_map
        .into_iter()
        .map(|(slot, (offset, read, write))| (slot, offset, read, write))
        .collect();
    slots.sort_by_key(|&(slot, _, _, _)| slot);

    slots
        .into_iter()
        .map(|(slot, offset, read, write)| {
            let access = match (read, write) {
                (true, true) => "readwrite".to_string(),
                (true, false) => "read".to_string(),
                (false, true) => "write".to_string(),
                (false, false) => "unknown".to_string(),
            };
            StorageSlot {
                slot,
                offset,
                access,
            }
        })
        .collect()
}

/// Parse bytecode into a list of (offset, opcode) pairs, correctly skipping
/// PUSH data bytes so they aren't confused for opcodes.
fn parse_opcodes(bytecode: &[u8]) -> Vec<(usize, u8)> {
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

/// Convert a big-endian byte slice to u64. If the value exceeds u64::MAX,
/// it saturates — this is fine for our purposes since very large slot
/// numbers are typically hash-based and we just want a label.
fn bytes_to_u64(bytes: &[u8]) -> u64 {
    let mut result: u64 = 0;
    for &b in bytes {
        // Saturate on overflow rather than wrapping
        result = result.saturating_mul(256).saturating_add(b as u64);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_sstore() {
        // PUSH1 0x00  PUSH1 0x42  SSTORE
        // Store value 0x42 at slot 0
        let bytecode = vec![
            0x60, 0x42, // PUSH1 0x42  (value)
            0x60, 0x00, // PUSH1 0x00  (slot)
            0x55, // SSTORE
        ];
        let slots = analyze_bytecode(&bytecode);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].slot, 0);
        assert_eq!(slots[0].access, "write");
    }

    #[test]
    fn test_sload() {
        // PUSH1 0x01  SLOAD
        let bytecode = vec![
            0x60, 0x01, // PUSH1 0x01
            0x54, // SLOAD
        ];
        let slots = analyze_bytecode(&bytecode);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].slot, 1);
        assert_eq!(slots[0].access, "read");
    }

    #[test]
    fn test_readwrite() {
        // PUSH1 0x00 SLOAD ... PUSH1 0x00 SSTORE
        let bytecode = vec![
            0x60, 0x00, 0x54, // PUSH1 0x00 SLOAD
            0x60, 0x01, 0x01, // PUSH1 0x01 ADD (dummy)
            0x60, 0x00, 0x55, // PUSH1 0x00 SSTORE
        ];
        let slots = analyze_bytecode(&bytecode);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].slot, 0);
        assert_eq!(slots[0].access, "readwrite");
    }
}
