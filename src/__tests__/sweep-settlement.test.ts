import { describe, it, expect, vi } from 'vitest';
import {
  handleIssuedQuote,
  handlePaidSettlement,
  decideSweepAction,
  type SweepDeps,
  type PaidSettlementDeps,
  type SweepQuoteAction,
} from '../lib/transaction-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSweepDeps(overrides?: Partial<SweepDeps>): SweepDeps {
  return {
    recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 0, proofsFailed: 0 }),
    refreshProofs: vi.fn().mockResolvedValue(undefined),
    completeTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePaidDeps(overrides?: Partial<PaidSettlementDeps>): PaidSettlementDeps {
  return {
    ...makeSweepDeps(overrides),
    mintTokens: vi.fn().mockResolvedValue([
      { amount: 500, id: 'ks1', secret: 's1', C: 'C1' },
      { amount: 500, id: 'ks1', secret: 's2', C: 'C2' },
    ]),
    isDleqValid: vi.fn().mockResolvedValue(true),
    safeStoreReceivedProofs: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const issuedAction: SweepQuoteAction & { type: 'complete' } = {
  type: 'complete',
  memo: 'Lightning receive (already minted)',
  needsStashRecovery: true,
};

const state = {
  mintUrl: 'https://mint.example',
  amount: 1000,
  quoteId: 'q-123',
  unit: 'sat',
  source: 'lightning' as const,
};

const mint = { contextId: 'ctx-1', url: 'https://mint.example', unit: 'sat' };

// ---------------------------------------------------------------------------
// handleIssuedQuote
// ---------------------------------------------------------------------------

describe('handleIssuedQuote', () => {
  it('completes when stash recovery succeeds with no failures', async () => {
    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 2, proofsFailed: 0 }),
    });

    const outcome = await handleIssuedQuote('tx-1', issuedAction, deps);

    expect(outcome).toEqual({ result: 'completed', memo: issuedAction.memo });
    expect(deps.recoverProofStashes).toHaveBeenCalled();
    expect(deps.refreshProofs).toHaveBeenCalled();
    expect(deps.completeTransaction).toHaveBeenCalledWith('tx-1', { memo: issuedAction.memo });
  });

  it('defers when stash recovery has failed proof writes', async () => {
    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 1, proofsFailed: 2 }),
    });

    const outcome = await handleIssuedQuote('tx-1', issuedAction, deps);

    expect(outcome.result).toBe('deferred');
    expect((outcome as { result: 'deferred'; reason: string }).reason).toContain('incomplete');
    expect(deps.completeTransaction).not.toHaveBeenCalled();
  });

  it('completes when stash recovery returns null (no repo)', async () => {
    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue(null),
    });

    const outcome = await handleIssuedQuote('tx-1', issuedAction, deps);

    // null means repo not ready — but no failures either, so complete
    expect(outcome).toEqual({ result: 'completed', memo: issuedAction.memo });
    expect(deps.completeTransaction).toHaveBeenCalled();
  });

  it('completes when no stash recovery needed', async () => {
    const noRecoveryAction: SweepQuoteAction & { type: 'complete' } = {
      type: 'complete',
      memo: 'Some memo',
      needsStashRecovery: false,
    };
    const deps = makeSweepDeps();

    const outcome = await handleIssuedQuote('tx-1', noRecoveryAction, deps);

    expect(outcome).toEqual({ result: 'completed', memo: 'Some memo' });
    expect(deps.recoverProofStashes).not.toHaveBeenCalled();
    expect(deps.completeTransaction).toHaveBeenCalled();
  });

  it('skips refreshProofs when no proofs were recovered', async () => {
    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 0, proofsFailed: 0 }),
    });

    await handleIssuedQuote('tx-1', issuedAction, deps);

    expect(deps.refreshProofs).not.toHaveBeenCalled();
    expect(deps.completeTransaction).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handlePaidSettlement
// ---------------------------------------------------------------------------

describe('handlePaidSettlement', () => {
  it('completes when proofs fully persisted', async () => {
    const deps = makePaidDeps();

    const outcome = await handlePaidSettlement('tx-1', state, mint, deps);

    expect(outcome).toEqual({ result: 'completed', total: 1000, memo: 'Lightning receive' });
    expect(deps.mintTokens).toHaveBeenCalledWith(state.mintUrl, state.amount, state.quoteId, state.unit);
    expect(deps.isDleqValid).toHaveBeenCalled();
    expect(deps.safeStoreReceivedProofs).toHaveBeenCalled();
    expect(deps.completeTransaction).toHaveBeenCalledWith('tx-1', { amount: 1000, memo: 'Lightning receive' });
    expect(deps.refreshProofs).toHaveBeenCalled();
  });

  it('defers when proof persistence is partial', async () => {
    const deps = makePaidDeps({
      safeStoreReceivedProofs: vi.fn().mockResolvedValue(false),
    });

    const outcome = await handlePaidSettlement('tx-1', state, mint, deps);

    expect(outcome.result).toBe('deferred');
    expect((outcome as { result: 'deferred'; reason: string }).reason).toContain('partial');
    expect(deps.completeTransaction).not.toHaveBeenCalled();
    expect(deps.refreshProofs).not.toHaveBeenCalled();
  });

  it('still persists proofs even when DLEQ verification fails', async () => {
    const deps = makePaidDeps({
      isDleqValid: vi.fn().mockResolvedValue(false),
    });

    const outcome = await handlePaidSettlement('tx-1', state, mint, deps);

    expect(outcome.result).toBe('completed');
    expect(deps.safeStoreReceivedProofs).toHaveBeenCalled();
    expect(deps.completeTransaction).toHaveBeenCalled();
  });

  it('includes LNURL description in memo', async () => {
    const lnurlState = { ...state, source: 'lnurl-withdraw' as const, description: 'My Service' };
    const deps = makePaidDeps();

    const outcome = await handlePaidSettlement('tx-1', lnurlState, mint, deps);

    expect(outcome).toEqual({ result: 'completed', total: 1000, memo: 'LNURL withdraw: My Service' });
  });

  it('uses generic LNURL memo when no description', async () => {
    const lnurlState = { ...state, source: 'lnurl-withdraw' as const };
    const deps = makePaidDeps();

    const outcome = await handlePaidSettlement('tx-1', lnurlState, mint, deps);

    expect(outcome).toEqual({ result: 'completed', total: 1000, memo: 'LNURL withdraw' });
  });
});

// ---------------------------------------------------------------------------
// Integration: decideSweepAction → handleIssuedQuote pipeline
// ---------------------------------------------------------------------------

describe('decideSweepAction → handleIssuedQuote pipeline', () => {
  it('ISSUED with successful stash recovery completes the transaction', async () => {
    const action = decideSweepAction('ISSUED', 'lightning', null);
    expect(action.type).toBe('complete');

    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 3, proofsFailed: 0 }),
    });

    const outcome = await handleIssuedQuote('tx-1', action as SweepQuoteAction & { type: 'complete' }, deps);

    expect(outcome.result).toBe('completed');
    expect(deps.completeTransaction).toHaveBeenCalled();
  });

  it('ISSUED with partial stash recovery defers', async () => {
    const action = decideSweepAction('ISSUED', 'lnurl-withdraw', null, 'Service');
    expect(action.type).toBe('complete');

    const deps = makeSweepDeps({
      recoverProofStashes: vi.fn().mockResolvedValue({ proofsRecovered: 1, proofsFailed: 1 }),
    });

    const outcome = await handleIssuedQuote('tx-1', action as SweepQuoteAction & { type: 'complete' }, deps);

    expect(outcome.result).toBe('deferred');
    expect(deps.completeTransaction).not.toHaveBeenCalled();
  });
});
