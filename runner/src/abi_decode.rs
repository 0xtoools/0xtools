use crate::signature_db;
use crate::types::{AbiDecodeResult, DecodedValue};
use alloy_dyn_abi::DynSolType;
use eyre::{Result, WrapErr};

/// Decode ABI-encoded data.
///
/// If `types` is provided, decode the data as the given types (comma-separated).
/// If `types` is not provided and the data is >= 4 bytes, treat the first 4 bytes
/// as a function selector, look it up in the signature database, and attempt to
/// decode the remaining data using the matched signature's parameter types.
pub fn decode(data_hex: &str, types: Option<&str>) -> Result<AbiDecodeResult> {
    let hex_str = data_hex.strip_prefix("0x").unwrap_or(data_hex);
    let data = hex::decode(hex_str).wrap_err("invalid hex data")?;

    if let Some(type_spec) = types {
        // User-provided type specification
        return decode_with_types(&data, type_spec);
    }

    // Auto-detect: try function calldata (selector + params)
    if data.len() >= 4 {
        let selector = format!("0x{}", hex::encode(&data[..4]));
        let param_data = &data[4..];

        // Look up selector in signature database
        let sig_match = signature_db::lookup(&selector);
        if !sig_match.signatures.is_empty() {
            // Try each matching signature
            for sig in &sig_match.signatures {
                if let Ok(result) = try_decode_with_signature(&selector, sig, param_data) {
                    return Ok(result);
                }
            }
            // If none decoded successfully, return the match info without decoded values
            return Ok(AbiDecodeResult {
                selector: Some(selector),
                function: Some(sig_match.signatures[0].clone()),
                values: vec![DecodedValue {
                    type_name: "raw".to_string(),
                    value: format!("0x{}", hex::encode(param_data)),
                }],
            });
        }

        // No signature match — return raw
        return Ok(AbiDecodeResult {
            selector: Some(selector),
            function: None,
            values: if param_data.is_empty() {
                Vec::new()
            } else {
                vec![DecodedValue {
                    type_name: "raw".to_string(),
                    value: format!("0x{}", hex::encode(param_data)),
                }]
            },
        });
    }

    // Data too short for a selector
    if data.is_empty() {
        return Ok(AbiDecodeResult {
            selector: None,
            function: None,
            values: Vec::new(),
        });
    }

    Ok(AbiDecodeResult {
        selector: None,
        function: None,
        values: vec![DecodedValue {
            type_name: "raw".to_string(),
            value: format!("0x{}", hex::encode(&data)),
        }],
    })
}

/// Decode data using a user-specified type list (comma-separated).
fn decode_with_types(data: &[u8], type_spec: &str) -> Result<AbiDecodeResult> {
    let type_strs: Vec<&str> = type_spec.split(',').map(|s| s.trim()).collect();
    let sol_types: Vec<DynSolType> = type_strs
        .iter()
        .map(|t| {
            t.parse::<DynSolType>()
                .wrap_err_with(|| format!("invalid Solidity type: {t}"))
        })
        .collect::<Result<Vec<_>>>()?;

    // Check if data starts with a 4-byte selector
    let (selector, param_data) = if data.len() >= 4 && data.len() > total_min_size(&sol_types) {
        (
            Some(format!("0x{}", hex::encode(&data[..4]))),
            &data[4..],
        )
    } else {
        (None, data)
    };

    let tuple_type = DynSolType::Tuple(sol_types.clone());
    let decoded = tuple_type
        .abi_decode_params(param_data)
        .wrap_err("failed to ABI-decode data with provided types")?;

    let values = match decoded {
        alloy_dyn_abi::DynSolValue::Tuple(vals) => vals
            .into_iter()
            .zip(type_strs.iter())
            .map(|(val, ty)| DecodedValue {
                type_name: ty.to_string(),
                value: format_sol_value(&val),
            })
            .collect(),
        single => vec![DecodedValue {
            type_name: type_strs.first().unwrap_or(&"unknown").to_string(),
            value: format_sol_value(&single),
        }],
    };

    Ok(AbiDecodeResult {
        selector,
        function: None,
        values,
    })
}

/// Try to decode parameter data using a function signature string like "transfer(address,uint256)".
fn try_decode_with_signature(
    selector: &str,
    signature: &str,
    param_data: &[u8],
) -> Result<AbiDecodeResult> {
    // Parse "funcName(type1,type2,...)" into parameter types
    let paren_start = signature
        .find('(')
        .ok_or_else(|| eyre::eyre!("invalid signature: no opening paren"))?;
    let paren_end = signature
        .rfind(')')
        .ok_or_else(|| eyre::eyre!("invalid signature: no closing paren"))?;
    let _func_name = &signature[..paren_start];
    let params_str = &signature[paren_start + 1..paren_end];

    if params_str.is_empty() {
        // No parameters
        return Ok(AbiDecodeResult {
            selector: Some(selector.to_string()),
            function: Some(signature.to_string()),
            values: Vec::new(),
        });
    }

    // Split on commas, but respect nested parens for tuple types
    let type_strs = split_params(params_str);
    let sol_types: Vec<DynSolType> = type_strs
        .iter()
        .map(|t| {
            t.parse::<DynSolType>()
                .wrap_err_with(|| format!("failed to parse type: {t}"))
        })
        .collect::<Result<Vec<_>>>()?;

    if param_data.is_empty() && sol_types.is_empty() {
        return Ok(AbiDecodeResult {
            selector: Some(selector.to_string()),
            function: Some(signature.to_string()),
            values: Vec::new(),
        });
    }

    let tuple_type = DynSolType::Tuple(sol_types);
    let decoded = tuple_type.abi_decode_params(param_data)?;

    let values = match decoded {
        alloy_dyn_abi::DynSolValue::Tuple(vals) => vals
            .into_iter()
            .zip(type_strs.iter())
            .map(|(val, ty)| DecodedValue {
                type_name: ty.to_string(),
                value: format_sol_value(&val),
            })
            .collect(),
        single => vec![DecodedValue {
            type_name: "unknown".to_string(),
            value: format_sol_value(&single),
        }],
    };

    Ok(AbiDecodeResult {
        selector: Some(selector.to_string()),
        function: Some(signature.to_string()),
        values,
    })
}

/// Split a parameter string on commas, respecting nested parentheses.
fn split_params(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut depth = 0;

    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    result.push(trimmed);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        result.push(trimmed);
    }
    result
}

/// Estimate the minimum ABI-encoded size for a set of types.
fn total_min_size(types: &[DynSolType]) -> usize {
    // Each ABI slot is 32 bytes minimum
    types.len() * 32
}

/// Format a DynSolValue into a human-readable string.
fn format_sol_value(val: &alloy_dyn_abi::DynSolValue) -> String {
    use alloy_dyn_abi::DynSolValue;
    match val {
        DynSolValue::Bool(b) => b.to_string(),
        DynSolValue::Uint(u, _) => u.to_string(),
        DynSolValue::Int(i, _) => i.to_string(),
        DynSolValue::Address(a) => format!("{a}"),
        DynSolValue::Bytes(b) => format!("0x{}", hex::encode(b)),
        DynSolValue::String(s) => format!("\"{s}\""),
        DynSolValue::FixedBytes(w, _) => format!("0x{}", hex::encode(w.as_slice())),
        DynSolValue::Array(items) => {
            let inner: Vec<String> = items.iter().map(format_sol_value).collect();
            format!("[{}]", inner.join(", "))
        }
        DynSolValue::FixedArray(items) => {
            let inner: Vec<String> = items.iter().map(format_sol_value).collect();
            format!("[{}]", inner.join(", "))
        }
        DynSolValue::Tuple(items) => {
            let inner: Vec<String> = items.iter().map(format_sol_value).collect();
            format!("({})", inner.join(", "))
        }
        DynSolValue::Function(f) => format!("0x{}", hex::encode(f.as_slice())),
    }
}
