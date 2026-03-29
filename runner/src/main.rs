mod abi_decode;
mod call_graph;
mod calldata;
mod cfg;
mod compile;
mod evm;
mod fuzzer;
mod signature_db;
mod storage_layout;
mod types;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use types::ContractReport;

#[derive(Parser)]
#[command(
    name = "sigscan-runner",
    about = "Compile Solidity contracts, deploy in-memory, execute functions, report gas."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Legacy: path to .sol file (equivalent to `gas <file>`)
    #[arg(global = false)]
    sol_file: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Commands {
    /// Compile and execute for gas estimation (default)
    Gas {
        /// Path to the .sol file
        sol_file: PathBuf,
    },
    /// Analyze storage layout from bytecode
    StorageLayout {
        /// Path to the .sol file
        sol_file: PathBuf,
    },
    /// Generate control flow graph
    Cfg {
        /// Path to the .sol file
        sol_file: PathBuf,
    },
    /// Build call graph
    CallGraph {
        /// Path to the .sol file
        sol_file: PathBuf,
    },
    /// Decode ABI-encoded data
    AbiDecode {
        /// Hex-encoded data to decode (with or without 0x prefix)
        data: String,
        /// Comma-separated Solidity types (e.g. "address,uint256")
        #[arg(short, long)]
        types: Option<String>,
    },
    /// Look up function signatures by selector or name
    SigDb {
        /// 4-byte selector (e.g. "0xa9059cbb") or function name for reverse lookup
        selector: String,
    },
    /// Fuzz test contract functions with random inputs
    Fuzz {
        /// Path to the .sol file
        sol_file: PathBuf,
        /// Number of fuzz rounds per function
        #[arg(short, long, default_value = "50")]
        rounds: u32,
    },
}

fn main() -> eyre::Result<()> {
    color_eyre::install()?;

    let cli = Cli::parse();

    // Determine which command to run
    match cli.command {
        Some(cmd) => run_command(cmd),
        None => {
            // Legacy mode: treat positional arg as `gas <file>`
            match cli.sol_file {
                Some(path) => run_command(Commands::Gas { sol_file: path }),
                None => {
                    eprintln!("Usage: sigscan-runner <sol_file>");
                    eprintln!("       sigscan-runner <command> [args]");
                    eprintln!();
                    eprintln!("Run `sigscan-runner --help` for more information.");
                    std::process::exit(1);
                }
            }
        }
    }
}

fn run_command(cmd: Commands) -> eyre::Result<()> {
    match cmd {
        Commands::Gas { sol_file } => cmd_gas(&sol_file),
        Commands::StorageLayout { sol_file } => cmd_storage_layout(&sol_file),
        Commands::Cfg { sol_file } => cmd_cfg(&sol_file),
        Commands::CallGraph { sol_file } => cmd_call_graph(&sol_file),
        Commands::AbiDecode { data, types } => cmd_abi_decode(&data, types.as_deref()),
        Commands::SigDb { selector } => cmd_sig_db(&selector),
        Commands::Fuzz { sol_file, rounds } => cmd_fuzz(&sol_file, rounds),
    }
}

// ---------------------------------------------------------------------------
// Subcommand implementations
// ---------------------------------------------------------------------------

/// Gas estimation (original behavior).
fn cmd_gas(sol_file: &PathBuf) -> eyre::Result<()> {
    validate_sol_file(sol_file)?;

    let contracts = compile::compile(sol_file)?;
    if contracts.is_empty() {
        println!("[]");
        return Ok(());
    }

    let mut reports = Vec::new();
    for contract in &contracts {
        let functions = match evm::execute_contract(contract) {
            Ok(funcs) => funcs,
            Err(e) => {
                eprintln!("Warning: {} - {e}", contract.name);
                Vec::new()
            }
        };
        reports.push(ContractReport {
            contract: contract.name.clone(),
            functions,
        });
    }

    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");
    Ok(())
}

/// Storage layout analysis.
fn cmd_storage_layout(sol_file: &PathBuf) -> eyre::Result<()> {
    validate_sol_file(sol_file)?;
    let contracts = compile::compile(sol_file)?;
    let reports = storage_layout::analyze_storage(&contracts);
    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");
    Ok(())
}

/// Control flow graph generation.
fn cmd_cfg(sol_file: &PathBuf) -> eyre::Result<()> {
    validate_sol_file(sol_file)?;
    let contracts = compile::compile(sol_file)?;
    let reports = cfg::build_cfg(&contracts);
    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");
    Ok(())
}

/// Call graph building.
fn cmd_call_graph(sol_file: &PathBuf) -> eyre::Result<()> {
    validate_sol_file(sol_file)?;
    let contracts = compile::compile(sol_file)?;
    let reports = call_graph::build_call_graph(&contracts);
    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");
    Ok(())
}

/// ABI data decoding.
fn cmd_abi_decode(data: &str, types: Option<&str>) -> eyre::Result<()> {
    let result = abi_decode::decode(data, types)?;
    let json = serde_json::to_string_pretty(&result)?;
    println!("{json}");
    Ok(())
}

/// Signature database lookup.
fn cmd_sig_db(selector: &str) -> eyre::Result<()> {
    // Determine if this is a selector lookup or a reverse (name) lookup.
    // Selectors start with "0x" and are 10 chars (0x + 8 hex digits).
    let stripped = selector.strip_prefix("0x").unwrap_or(selector);
    let is_selector = stripped.len() == 8 && stripped.chars().all(|c| c.is_ascii_hexdigit());

    if is_selector {
        let result = signature_db::lookup(selector);
        let json = serde_json::to_string_pretty(&result)?;
        println!("{json}");
    } else {
        let results = signature_db::reverse_lookup(selector);
        let json = serde_json::to_string_pretty(&results)?;
        println!("{json}");
    }
    Ok(())
}

/// Fuzz testing.
fn cmd_fuzz(sol_file: &PathBuf, rounds: u32) -> eyre::Result<()> {
    validate_sol_file(sol_file)?;
    let contracts = compile::compile(sol_file)?;
    let reports = fuzzer::fuzz_contracts(&contracts, rounds);
    let json = serde_json::to_string_pretty(&reports)?;
    println!("{json}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

fn validate_sol_file(sol_file: &PathBuf) -> eyre::Result<()> {
    if !sol_file.exists() {
        eyre::bail!("File not found: {}", sol_file.display());
    }
    if sol_file.extension().and_then(|e| e.to_str()) != Some("sol") {
        eyre::bail!("Expected a .sol file, got: {}", sol_file.display());
    }
    Ok(())
}
