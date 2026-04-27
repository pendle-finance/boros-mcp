// Calldata extraction, agent signing orchestration, sim-stage guards, exec-result error reporting.
import type { Address, Hex } from 'viem';
import { sendTxsBotPost } from '../../api/send-txs-bot.js';
import { bulkSignWithAgent, type IntentExpectation } from '../../agent/signing.js';
import { analyzeExecution } from '../../utils.js';
import { errorContent, structuredError, BorosErrorCode } from '../../agent/errors.js';

// Throws on unexpected shape so we never sign garbage.
export function extractCalldatas(res: any): Hex[] {
  if (res?.calls && Array.isArray(res.calls)) {
    return res.calls.map((c: any) => c.calldata as Hex);
  }
  throw new Error('Unexpected calldata response shape — expected { calls: [...] }');
}

// One tryAggregate tx per batch → single txHash. Prefer result.txHash, fall back to execution[].txHash.
export function extractTxHash(result: any): string | undefined {
  const top = result?.txHash;
  if (typeof top === 'string' && top.length > 0) return top;
  const entries: any[] = Array.isArray(result?.execution) ? result.execution : [];
  for (const e of entries) {
    if (e && typeof e.txHash === 'string' && e.txHash.length > 0) return e.txHash;
  }
  return undefined;
}

// Intents are verified inside bulkSignWithAgent BEFORE signing — blocks selector-allowlisted
// calldata that doesn't match user intent.
export async function executeAgentAction(
  calldatas: Hex[],
  root: Address,
  accountId: number,
  expected?: string[],
  options?: { atomic?: boolean; intents?: IntentExpectation[] },
) {
  const signedExecutions = await bulkSignWithAgent(
    root,
    accountId,
    calldatas,
    expected,
    options?.intents,
  );

  const response = await sendTxsBotPost('/v2/agent/bulk-direct-call', {
    datas: signedExecutions.map((se) => ({
      agent: se.agent,
      message: se.message,
      signature: se.signature,
      calldata: se.calldata,
    })),
    // MM opts out (atomic:false) so 1 stale rung doesn't revert the refresh.
    requireSuccess: options?.atomic ?? true,
  });

  return response;
}

// On any sub-revert MUST return isError EXECUTION_REVERTED — else supervisors trust failed tx.
// Returns null when all succeeded.
export function executionErrorContent(
  action: string,
  result: any,
): ReturnType<typeof errorContent> | null {
  const status = analyzeExecution(result);
  if (status.entries.length === 0 || status.allSuccess) return null;
  const summary = status.reverts
    .map((r) => `#${r.index}: ${r.error}`)
    .join('; ');
  const err = structuredError(
    BorosErrorCode.EXECUTION_REVERTED,
    `${action} reverted on-chain: ${summary}`,
  );
  (err.error as any).reverts = status.reverts;
  (err.error as any).successCount = status.successCount;
  const pretty = process.env.BOROS_MCP_PRETTY === '1';
  return {
    content: [{ type: 'text' as const, text: pretty ? JSON.stringify(err, null, 2) : JSON.stringify(err) }],
    isError: true,
  };
}

// Selects per-site error phrasing.
export type SimVariant = 'order' | 'close';

// Returns SIMULATION_FAILED envelope on fail or null on success.
// `isMarketOrder` toggles the missing-priceImpact guard.
export function assertSimSucceeded(
  sim: any,
  opts: { variant: SimVariant; isMarketOrder?: boolean },
): ReturnType<typeof errorContent> | null {
  const isClose = opts.variant === 'close';
  const actionLabel = isClose ? 'Close' : 'Order';
  if (sim.statusCode !== 'Succeed' && sim.status !== 'Succeed') {
    return errorContent(
      BorosErrorCode.SIMULATION_FAILED,
      `${actionLabel} simulation failed: ${sim.statusCode ?? sim.status}. ` +
      `If this mentions gas or treasury, top up via pay_gas first.`,
    );
  }
  if (sim.priceImpact === undefined && opts.isMarketOrder === true) {
    if (isClose) {
      return errorContent(
        BorosErrorCode.SIMULATION_FAILED,
        'Simulation did not return priceImpact for this MARKET close (empty book or zero cross). Refusing to execute without an impact estimate. Use a limit close or retry when the book has depth.',
      );
    }
    return errorContent(
      BorosErrorCode.SIMULATION_FAILED,
      'Simulation did not return priceImpact for this MARKET order (empty book or zero cross). Refusing to place without an impact estimate. Use a limit order or retry when the book has depth.',
    );
  }
  return null;
}

// Returns PRICE_IMPACT_TOO_HIGH envelope on breach, or null on pass / undefined priceImpact.
export function assertPriceImpactWithinSlippage(
  sim: any,
  slippage: number,
  opts: { variant: SimVariant },
): ReturnType<typeof errorContent> | null {
  // abs() = symmetric reject for shorts (signed priceImpact can be neg when exec beats mid).
  const fallback = opts.variant === 'close' ? 'limit close' : 'limit order';
  if (sim.priceImpact !== undefined && Math.abs(sim.priceImpact) > slippage) {
    return errorContent(
      BorosErrorCode.PRICE_IMPACT_TOO_HIGH,
      `Price impact ${(sim.priceImpact * 100).toFixed(2)}% (|impact| ${(Math.abs(sim.priceImpact) * 100).toFixed(2)}%) exceeds slippage tolerance ${(slippage * 100).toFixed(2)}%. Increase slippage or use a ${fallback}.`,
    );
  }
  return null;
}
