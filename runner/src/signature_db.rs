use crate::types::SignatureMatch;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Bundled signature database loaded from data/signatures.json at compile time.
static SIGNATURES: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let data = include_str!("../data/signatures.json");
    serde_json::from_str(data).unwrap_or_default()
});

/// Look up function signatures by 4-byte selector (e.g. "0xa9059cbb").
///
/// Returns a SignatureMatch with matching function signatures, or an empty
/// match if the selector is not found.
pub fn lookup(selector: &str) -> SignatureMatch {
    let normalized = normalize_selector(selector);

    match SIGNATURES.get(&normalized) {
        Some(sigs) => SignatureMatch {
            selector: normalized,
            signatures: sigs.clone(),
        },
        None => SignatureMatch {
            selector: normalized,
            signatures: Vec::new(),
        },
    }
}

/// Reverse lookup: find selectors by function name or partial signature.
///
/// Searches all known signatures for ones containing the query string.
pub fn reverse_lookup(query: &str) -> Vec<SignatureMatch> {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for (selector, sigs) in SIGNATURES.iter() {
        let matching: Vec<String> = sigs
            .iter()
            .filter(|s| s.to_lowercase().contains(&query_lower))
            .cloned()
            .collect();

        if !matching.is_empty() {
            results.push(SignatureMatch {
                selector: selector.clone(),
                signatures: matching,
            });
        }
    }

    // Sort by selector for deterministic output
    results.sort_by(|a, b| a.selector.cmp(&b.selector));
    results
}

/// Normalize a selector to lowercase with 0x prefix.
fn normalize_selector(selector: &str) -> String {
    let stripped = selector.strip_prefix("0x").unwrap_or(selector);
    format!("0x{}", stripped.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lookup_known() {
        let result = lookup("0xa9059cbb");
        assert!(!result.signatures.is_empty());
        assert!(result.signatures[0].contains("transfer"));
    }

    #[test]
    fn test_lookup_unknown() {
        let result = lookup("0xdeadbeef");
        assert!(result.signatures.is_empty());
    }

    #[test]
    fn test_reverse_lookup() {
        let results = reverse_lookup("transfer");
        assert!(!results.is_empty());
    }

    #[test]
    fn test_normalize() {
        assert_eq!(normalize_selector("0xA9059CBB"), "0xa9059cbb");
        assert_eq!(normalize_selector("a9059cbb"), "0xa9059cbb");
    }
}
