use crate::calldata::{encode_constructor_args_with_strategy, CallStrategy};
use crate::types::{CompiledContract, ExecutionStatus, FuzzReport, FuzzResult};
use alloy_dyn_abi::{DynSolType, DynSolValue};
use alloy_json_abi::{Function, Param};
use alloy_primitives::{Address, Bytes, I256, TxKind, U256};
use eyre::{bail, Result, WrapErr};
use rand::Rng;
use revm::context::TxEnv;
use revm::context_interface::result::{ExecutionResult, Output};
use revm::database::CacheDB;
use revm::database_interface::EmptyDB;
use revm::state::AccountInfo;
use revm::{ExecuteCommitEvm, ExecuteEvm, MainBuilder, MainContext};

const GAS_LIMIT: u64 = 30_000_000;

fn caller() -> Address {
    Address::new([
        0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01,
    ])
}

fn setup_db() -> CacheDB<EmptyDB> {
    let mut db = CacheDB::new(EmptyDB::new());
    let balance = U256::from(10_000u64) * U256::from(10u64).pow(U256::from(18u64));
    db.insert_account_info(
        caller(),
        AccountInfo {
            balance,
            nonce: 0,
            ..Default::default()
        },
    );
    db
}

/// Fuzz all public/external functions of each compiled contract.
pub fn fuzz_contracts(contracts: &[CompiledContract], rounds: u32) -> Vec<FuzzReport> {
    contracts
        .iter()
        .filter_map(|c| match fuzz_single_contract(c, rounds) {
            Ok(report) => Some(report),
            Err(e) => {
                eprintln!("Warning: fuzzing {} failed — {e}", c.name);
                None
            }
        })
        .collect()
}

fn fuzz_single_contract(contract: &CompiledContract, rounds: u32) -> Result<FuzzReport> {
    let caller_addr = caller();
    let (base_db, addr) = deploy_best(contract, caller_addr)?;

    let mut results = Vec::new();

    for func_list in contract.abi.functions.values() {
        for func in func_list {
            let result = fuzz_function(&base_db, addr, func, caller_addr, rounds);
            results.push(result);
        }
    }

    Ok(FuzzReport {
        contract: contract.name.clone(),
        results,
    })
}

/// Deploy a contract using the best strategy (same as evm.rs).
fn deploy_best(
    contract: &CompiledContract,
    caller_addr: Address,
) -> Result<(CacheDB<EmptyDB>, Address)> {
    let strategies = [CallStrategy::SmartDefaults, CallStrategy::ZeroDefaults];
    let mut last_err = None;
    for strategy in &strategies {
        let ctor_args =
            match encode_constructor_args_with_strategy(&contract.abi, *strategy, caller_addr) {
                Ok(a) => a,
                Err(e) => {
                    last_err = Some(e);
                    continue;
                }
            };
        let mut data = contract.bytecode.clone();
        data.extend_from_slice(&ctor_args);
        match deploy(setup_db(), &data) {
            Ok(result) => return Ok(result),
            Err(e) => {
                last_err = Some(e);
                continue;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| eyre::eyre!("deployment failed")))
}

fn deploy(db: CacheDB<EmptyDB>, data: &[u8]) -> Result<(CacheDB<EmptyDB>, Address)> {
    let mut evm = revm::Context::mainnet().with_db(db).build_mainnet();
    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        kind: TxKind::Create,
        data: Bytes::copy_from_slice(data),
        ..Default::default()
    };
    let result = evm
        .transact_commit(tx)
        .map_err(|e| eyre::eyre!("deploy error: {e:?}"))?;
    match result {
        ExecutionResult::Success { output, .. } => match output {
            Output::Create(_, Some(addr)) => Ok((evm.ctx.journaled_state.database, addr)),
            Output::Create(_, None) => bail!("CREATE succeeded but no address returned"),
            Output::Call(_) => bail!("expected CREATE output, got CALL"),
        },
        ExecutionResult::Revert { output, .. } => {
            bail!("deploy reverted: 0x{}", hex::encode(&output))
        }
        ExecutionResult::Halt { reason, .. } => bail!("deploy halted: {reason:?}"),
    }
}

/// Fuzz a single function with random inputs across multiple rounds.
fn fuzz_function(
    base_db: &CacheDB<EmptyDB>,
    addr: Address,
    func: &Function,
    caller_addr: Address,
    rounds: u32,
) -> FuzzResult {
    let selector = format!("0x{}", hex::encode(func.selector().as_slice()));
    let mut successes: u32 = 0;
    let mut reverts: u32 = 0;
    let mut halts: u32 = 0;
    let mut min_gas: u64 = u64::MAX;
    let mut max_gas: u64 = 0;
    let mut total_gas: u64 = 0;
    let mut rng = rand::rng();

    for _ in 0..rounds {
        // Generate random calldata
        let calldata = match generate_random_calldata(func, caller_addr, &mut rng) {
            Ok(cd) => cd,
            Err(_) => continue,
        };

        // Clone the DB so each fuzz round starts from the same state
        let mut db = base_db.clone();
        let result = call_function(&mut db, addr, &calldata);

        match result {
            Ok((gas, status)) => {
                match status {
                    ExecutionStatus::Success => successes += 1,
                    ExecutionStatus::Revert => reverts += 1,
                    ExecutionStatus::Halt => halts += 1,
                }
                min_gas = min_gas.min(gas);
                max_gas = max_gas.max(gas);
                total_gas = total_gas.saturating_add(gas);
            }
            Err(_) => {
                halts += 1;
            }
        }
    }

    let completed = successes + reverts + halts;
    let avg_gas = if completed > 0 {
        total_gas / completed as u64
    } else {
        0
    };

    // If no rounds completed, reset min_gas
    if completed == 0 {
        min_gas = 0;
    }

    FuzzResult {
        function: func.name.clone(),
        selector,
        rounds,
        successes,
        reverts,
        halts,
        min_gas,
        max_gas,
        avg_gas,
    }
}

/// Execute a function call against a cloned DB.
fn call_function(
    db: &mut CacheDB<EmptyDB>,
    addr: Address,
    calldata: &[u8],
) -> Result<(u64, ExecutionStatus)> {
    let mut evm = revm::Context::mainnet().with_db(&mut *db).build_mainnet();
    let tx = TxEnv {
        caller: caller(),
        gas_limit: GAS_LIMIT,
        kind: TxKind::Call(addr),
        data: Bytes::copy_from_slice(calldata),
        nonce: 1,
        ..Default::default()
    };
    let result = evm
        .transact(tx)
        .map_err(|e| eyre::eyre!("call error: {e:?}"))?;
    let (gas, status) = match &result.result {
        ExecutionResult::Success { gas_used, .. } => (*gas_used, ExecutionStatus::Success),
        ExecutionResult::Revert { gas_used, .. } => (*gas_used, ExecutionStatus::Revert),
        ExecutionResult::Halt { gas_used, .. } => (*gas_used, ExecutionStatus::Halt),
    };
    Ok((gas, status))
}

/// Generate random ABI-encoded calldata for a function.
fn generate_random_calldata(
    func: &Function,
    caller_addr: Address,
    rng: &mut impl Rng,
) -> Result<Vec<u8>> {
    let selector = func.selector();

    if func.inputs.is_empty() {
        return Ok(selector.to_vec());
    }

    let values: Vec<DynSolValue> = func
        .inputs
        .iter()
        .map(|p| {
            let ty = param_to_dyn_sol_type(p)?;
            Ok(random_value(&ty, caller_addr, rng))
        })
        .collect::<Result<Vec<_>>>()?;

    let encoded = DynSolValue::Tuple(values).abi_encode_params();
    let mut calldata = Vec::with_capacity(4 + encoded.len());
    calldata.extend_from_slice(selector.as_slice());
    calldata.extend_from_slice(&encoded);
    Ok(calldata)
}

/// Convert an ABI param to a DynSolType (same logic as calldata.rs).
fn param_to_dyn_sol_type(param: &Param) -> Result<DynSolType> {
    let ty_str = &param.ty;
    if ty_str == "tuple" {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(param_to_dyn_sol_type)
            .collect::<Result<Vec<_>>>()?;
        return Ok(DynSolType::Tuple(inner));
    }
    if ty_str.starts_with("tuple[") {
        let inner: Vec<DynSolType> = param
            .components
            .iter()
            .map(param_to_dyn_sol_type)
            .collect::<Result<Vec<_>>>()?;
        let tuple_ty = DynSolType::Tuple(inner);
        if ty_str == "tuple[]" {
            return Ok(DynSolType::Array(Box::new(tuple_ty)));
        }
        let n_str = &ty_str[6..ty_str.len() - 1];
        if let Ok(n) = n_str.parse::<usize>() {
            return Ok(DynSolType::FixedArray(Box::new(tuple_ty), n));
        }
        return Ok(DynSolType::Array(Box::new(tuple_ty)));
    }
    ty_str
        .parse::<DynSolType>()
        .wrap_err_with(|| format!("failed to parse Solidity type: {ty_str}"))
}

/// Generate a random value for a given Solidity type.
fn random_value(ty: &DynSolType, caller_addr: Address, rng: &mut impl Rng) -> DynSolValue {
    match ty {
        DynSolType::Bool => DynSolValue::Bool(rng.random::<bool>()),
        DynSolType::Uint(bits) => {
            let val = random_uint(*bits, rng);
            DynSolValue::Uint(val, *bits)
        }
        DynSolType::Int(bits) => {
            let val = random_int(*bits, rng);
            DynSolValue::Int(val, *bits)
        }
        DynSolType::Address => {
            // Mix of random addresses and the caller address
            if rng.random_range(0..4u32) == 0 {
                DynSolValue::Address(caller_addr)
            } else {
                let mut addr_bytes = [0u8; 20];
                rng.fill(&mut addr_bytes[..]);
                DynSolValue::Address(Address::new(addr_bytes))
            }
        }
        DynSolType::Bytes => {
            let len = rng.random_range(0..64usize);
            let mut bytes = vec![0u8; len];
            rng.fill(&mut bytes[..]);
            DynSolValue::Bytes(bytes)
        }
        DynSolType::String => {
            let strings = [
                "hello",
                "",
                "test",
                "a]b[c",
                "\x00",
                "0x1234",
                "a]very]long]string]that]is]used]for]fuzzing",
            ];
            let idx = rng.random_range(0..strings.len());
            DynSolValue::String(strings[idx].to_string())
        }
        DynSolType::FixedBytes(n) => {
            let mut bytes = [0u8; 32];
            rng.fill(&mut bytes[..*n]);
            DynSolValue::FixedBytes(alloy_primitives::B256::from(bytes), *n)
        }
        DynSolType::Array(inner) => {
            let len = rng.random_range(0..4usize);
            let items = (0..len)
                .map(|_| random_value(inner, caller_addr, rng))
                .collect();
            DynSolValue::Array(items)
        }
        DynSolType::FixedArray(inner, n) => {
            let items = (0..*n)
                .map(|_| random_value(inner, caller_addr, rng))
                .collect();
            DynSolValue::FixedArray(items)
        }
        DynSolType::Tuple(types) => {
            let items = types
                .iter()
                .map(|t| random_value(t, caller_addr, rng))
                .collect();
            DynSolValue::Tuple(items)
        }
        DynSolType::Function => {
            let mut f = [0u8; 24];
            rng.fill(&mut f[..]);
            DynSolValue::Function(alloy_primitives::Function::from(f))
        }
    }
}

/// Generate a random U256 that fits within the given bit width.
fn random_uint(bits: usize, rng: &mut impl Rng) -> U256 {
    // Use a mix of edge cases and random values
    let choice = rng.random_range(0..10u32);
    match choice {
        0 => U256::ZERO,
        1 => U256::from(1u64),
        2 => {
            // Max value for this bit width
            if bits >= 256 {
                U256::MAX
            } else {
                (U256::from(1u64) << bits) - U256::from(1u64)
            }
        }
        3..=5 => {
            // Small random value
            U256::from(rng.random_range(0..1000u64))
        }
        _ => {
            // Full random value (truncated to bit width)
            let mut bytes = [0u8; 32];
            rng.fill(&mut bytes[..]);
            let val = U256::from_be_bytes(bytes);
            if bits < 256 {
                val & ((U256::from(1u64) << bits) - U256::from(1u64))
            } else {
                val
            }
        }
    }
}

/// Generate a random I256 that fits within the given bit width.
fn random_int(_bits: usize, rng: &mut impl Rng) -> I256 {
    let choice = rng.random_range(0..8u32);
    match choice {
        0 => I256::ZERO,
        1 => I256::try_from(1i64).unwrap_or(I256::ZERO),
        2 => I256::try_from(-1i64).unwrap_or(I256::ZERO),
        3..=5 => {
            let val = rng.random_range(-1000..1000i64);
            I256::try_from(val).unwrap_or(I256::ZERO)
        }
        _ => {
            let val = rng.random_range(i64::MIN..i64::MAX);
            I256::try_from(val).unwrap_or(I256::ZERO)
        }
    }
}
