import { createCompilationInput } from '../SolcManager';

interface InputShape {
  settings: {
    optimizer: { enabled: boolean; runs: number };
    evmVersion?: string;
    viaIR?: boolean;
    outputSelection: Record<string, unknown>;
  };
}

// The compilation-service always passes its full defaults explicitly, so the
// gate has to validate explicit values too, not just fill in defaults.
const SERVICE_DEFAULTS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'paris',
  viaIR: false,
};

const SRC = 'pragma solidity =0.6.6; contract T {}';

function build(settings?: typeof SERVICE_DEFAULTS, solcVersion?: string): InputShape {
  return createCompilationInput('T.sol', SRC, settings, solcVersion) as InputShape;
}

describe('createCompilationInput version gating', () => {
  test('omits viaIR and paris for solc 0.6.6 (both would reject the whole input)', () => {
    const input = build(SERVICE_DEFAULTS, '0.6.6');
    expect(input.settings).not.toHaveProperty('viaIR');
    expect(input.settings).not.toHaveProperty('evmVersion');
  });

  test('omits viaIR and paris for a full version tag (v0.6.6+commit.6c089d02)', () => {
    const input = build(SERVICE_DEFAULTS, 'v0.6.6+commit.6c089d02');
    expect(input.settings).not.toHaveProperty('viaIR');
    expect(input.settings).not.toHaveProperty('evmVersion');
  });

  test('keeps paris for solc 0.8.20 and omits viaIR when false', () => {
    const input = build(SERVICE_DEFAULTS, '0.8.20');
    expect(input.settings.evmVersion).toBe('paris');
    // viaIR: false is the compiler default; sending the key adds nothing.
    expect(input.settings).not.toHaveProperty('viaIR');
  });

  test('defaults to paris on modern solc when no settings are given', () => {
    const input = build(undefined, '0.8.28');
    expect(input.settings.evmVersion).toBe('paris');
  });

  test('omits evmVersion on old solc when no settings are given', () => {
    const input = build(undefined, '0.5.16');
    expect(input.settings).not.toHaveProperty('evmVersion');
  });

  test('keeps viaIR: true only on solc >= 0.8.13', () => {
    const on = build({ ...SERVICE_DEFAULTS, viaIR: true }, '0.8.13');
    expect(on.settings.viaIR).toBe(true);
    const off = build({ ...SERVICE_DEFAULTS, viaIR: true }, '0.8.12');
    expect(off.settings).not.toHaveProperty('viaIR');
  });

  test('keeps an explicit evmVersion its target supports', () => {
    const input = build({ ...SERVICE_DEFAULTS, evmVersion: 'london' }, '0.8.7');
    expect(input.settings.evmVersion).toBe('london');
  });

  test('drops an explicit evmVersion its target predates', () => {
    const input = build({ ...SERVICE_DEFAULTS, evmVersion: 'london' }, '0.6.6');
    expect(input.settings).not.toHaveProperty('evmVersion');
  });

  test('omits every gated key when the target version is unknown', () => {
    const input = build(SERVICE_DEFAULTS, undefined);
    expect(input.settings).not.toHaveProperty('viaIR');
    expect(input.settings).not.toHaveProperty('evmVersion');
    expect(input.settings.optimizer).toEqual({ enabled: true, runs: 200 });
  });
});
