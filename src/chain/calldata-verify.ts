// Calldata intent verifier for Pendle Boros Router calls.
// connectionId=keccak256(calldata) prevents post-sign swap, but a MITM'd open-api can still
// return correctly-formatted calldata for a DIFFERENT intent. assertCalldatasAllowed only
// checks the 4-byte selector; this adds semantic decoding+comparison against IntentExpectation.
// Conservative: missing field = "don't check"; present field = "must match exactly".
// Throws Error tagged __borosCode='INVALID_PARAMS' (prefix: "Calldata intent mismatch:").
// AMM ops (swapWithAmm, *Liquidity*, ammCashTransfer) are selector-only for now — deep nested
// slippage structs not yet wired into the trading-tools fast path.

import { type Hex, decodeFunctionData, parseAbiItem } from 'viem';
import { ROUTER_SELECTORS } from './selectors.js';
import { BorosErrorCode, tagBorosError } from '../agent/errors.js';

// Solidity type aliases decay to primitives for ABI: MarketId→uint24, OrderId→uint64, enums→uint8.
// Side: 0=LONG, 1=SHORT. TIF: 0=GTC, 1=IOC, 2=FOK, 3=ALO, 4=SOFT_ALO.

const ABI_PLACE_SINGLE_ORDER = parseAbiItem(
  'function placeSingleOrder((' +
    '(bool cross, uint24 marketId, uint24 ammId, uint8 side, uint8 tif, uint256 size, int16 tick) order,' +
    'bool enterMarket,' +
    'uint64 idToStrictCancel,' +
    'bool exitMarket,' +
    'uint256 isolated_cashIn,' +
    'bool isolated_cashTransferAll,' +
    'int128 desiredMatchRate' +
  ') req)',
);

const ABI_BULK_ORDERS = parseAbiItem(
  'function bulkOrders((' +
    'bool cross,' +
    '(' +
      'uint24 marketId,' +
      '(uint8 tif, uint8 side, uint256[] sizes, int16[] limitTicks) orders,' +
      '(uint64[] ids, bool isAll, bool isStrict) cancelData' +
    ')[] bulks,' +
    'int128[] desiredMatchRates' +
  ') req)',
);

const ABI_BULK_CANCELS = parseAbiItem(
  'function bulkCancels((bool cross, uint24 marketId, bool cancelAll, uint64[] orderIds) req)',
);

const ABI_CASH_TRANSFER = parseAbiItem(
  'function cashTransfer((uint24 marketId, int256 signedAmount) req)',
);

const ABI_PAY_TREASURY = parseAbiItem(
  'function payTreasury((bool cross, uint24 marketId, uint256 amount) req)',
);

const ABI_ENTER_EXIT_MARKETS = parseAbiItem(
  'function enterExitMarkets((bool cross, bool isEnter, uint24[] marketIds) req)',
);

export type SideEnum = 'long' | 'short' | 'LONG' | 'SHORT' | 0 | 1;

/** All fields optional. Missing = skip; present = must match. *Min/*Max are inclusive ranges. */
export interface IntentExpectation {
  /** 4-byte selector lowercase. REQUIRED — verifier dispatches on this. */
  selector: string;

  cross?: boolean;

  /** bytes26 packed (root|accId|tokenId|marketId). If passed, marketId is unpacked + checked. */
  marketAcc?: Hex;
  /** Direct uint24. If both marketAcc and marketId are set, they must agree. */
  marketId?: number;

  side?: SideEnum;
  tif?: number; // 0=GTC,1=IOC,2=FOK,3=ALO,4=SOFT_ALO
  sizeAbs?: bigint;
  sizeMin?: bigint;
  sizeMax?: bigint;
  tickExact?: number;
  tickMin?: number;
  tickMax?: number;
  /** uint24. Orderbook-only flows = 0. */
  ammId?: number;

  /** calldata's orderIds[] must be a SUBSET of this set. */
  orderIdsSubset?: bigint[];

  signedAmountExact?: bigint;
  signedAmountMin?: bigint;
  signedAmountMax?: bigint;
  amountExact?: bigint;
  amountMin?: bigint;
  amountMax?: bigint;

  isEnter?: boolean;
  /** marketIds[] must equal this set (order-insensitive). */
  marketIdsSet?: number[];
}

function mismatch(msg: string): never {
  throw tagBorosError(new Error(`Calldata intent mismatch: ${msg}`), BorosErrorCode.INVALID_PARAMS);
}

function eq<T>(label: string, got: T, want: T) {
  if (got !== want) mismatch(`${label}: calldata=${String(got)}, expected=${String(want)}`);
}

function eqBig(label: string, got: bigint, want: bigint) {
  if (got !== want) mismatch(`${label}: calldata=${got.toString()}, expected=${want.toString()}`);
}

function inRangeBig(label: string, got: bigint, min?: bigint, max?: bigint) {
  if (min !== undefined && got < min) mismatch(`${label}: calldata=${got.toString()} < min=${min.toString()}`);
  if (max !== undefined && got > max) mismatch(`${label}: calldata=${got.toString()} > max=${max.toString()}`);
}

function inRangeNum(label: string, got: number, min?: number, max?: number) {
  if (min !== undefined && got < min) mismatch(`${label}: calldata=${got} < min=${min}`);
  if (max !== undefined && got > max) mismatch(`${label}: calldata=${got} > max=${max}`);
}

function normSide(s: SideEnum): 0 | 1 {
  if (s === 0 || s === 1) return s;
  return s === 'long' || s === 'LONG' ? 0 : 1;
}

/** Extract marketId (low 24 bits) from a 26-byte packed marketAcc. */
function marketIdFromMarketAcc(marketAcc: Hex): number {
  const hex = marketAcc.startsWith('0x') ? marketAcc.slice(2) : marketAcc;
  if (hex.length !== 52) mismatch(`marketAcc must be 26 bytes (got ${hex.length / 2})`);
  const packed = BigInt('0x' + hex);
  return Number(packed & 0xffffffn);
}

interface DecodedSingleOrderArgs {
  args: readonly [{
    order: { cross: boolean; marketId: number; ammId: number; side: number; tif: number; size: bigint; tick: number };
    enterMarket: boolean;
    idToStrictCancel: bigint;
    exitMarket: boolean;
    isolated_cashIn: bigint;
    isolated_cashTransferAll: boolean;
    desiredMatchRate: bigint;
  }];
}

function verifyPlaceSingleOrder(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_PLACE_SINGLE_ORDER], data: calldata }) as unknown as DecodedSingleOrderArgs;
  const req = decoded.args[0];
  const o = req.order;

  if (e.marketId !== undefined) eq('placeSingleOrder.order.marketId', o.marketId, e.marketId);
  if (e.marketAcc !== undefined) {
    const mid = marketIdFromMarketAcc(e.marketAcc);
    eq('placeSingleOrder.order.marketId (vs marketAcc)', o.marketId, mid);
  }
  if (e.cross !== undefined) eq('placeSingleOrder.order.cross', o.cross, e.cross);
  if (e.side !== undefined) eq('placeSingleOrder.order.side', o.side, normSide(e.side));
  if (e.tif !== undefined) eq('placeSingleOrder.order.tif', o.tif, e.tif);
  if (e.ammId !== undefined) eq('placeSingleOrder.order.ammId', o.ammId, e.ammId);

  if (e.sizeAbs !== undefined) eqBig('placeSingleOrder.order.size', o.size, e.sizeAbs);
  inRangeBig('placeSingleOrder.order.size', o.size, e.sizeMin, e.sizeMax);

  if (e.tickExact !== undefined) eq('placeSingleOrder.order.tick', o.tick, e.tickExact);
  inRangeNum('placeSingleOrder.order.tick', o.tick, e.tickMin, e.tickMax);
}

interface DecodedBulkOrdersArgs {
  args: readonly [{
    cross: boolean;
    bulks: readonly {
      marketId: number;
      orders: { tif: number; side: number; sizes: readonly bigint[]; limitTicks: readonly number[] };
      cancelData: { ids: readonly bigint[]; isAll: boolean; isStrict: boolean };
    }[];
    desiredMatchRates: readonly bigint[];
  }];
}

function verifyBulkOrders(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_BULK_ORDERS], data: calldata }) as unknown as DecodedBulkOrdersArgs;
  const req = decoded.args[0];
  if (e.cross !== undefined) eq('bulkOrders.cross', req.cross, e.cross);

  // Conservative: every bulk MUST agree with caller's single marketId/side/tif if supplied.
  const expectMarketId =
    e.marketId !== undefined
      ? e.marketId
      : e.marketAcc !== undefined
      ? marketIdFromMarketAcc(e.marketAcc)
      : undefined;

  for (let bi = 0; bi < req.bulks.length; bi++) {
    const b = req.bulks[bi];
    if (expectMarketId !== undefined) eq(`bulkOrders.bulks[${bi}].marketId`, b.marketId, expectMarketId);
    if (e.side !== undefined) eq(`bulkOrders.bulks[${bi}].orders.side`, b.orders.side, normSide(e.side));
    if (e.tif !== undefined) eq(`bulkOrders.bulks[${bi}].orders.tif`, b.orders.tif, e.tif);

    if (b.orders.sizes.length !== b.orders.limitTicks.length) {
      mismatch(`bulkOrders.bulks[${bi}] sizes/limitTicks length mismatch`);
    }
    for (let oi = 0; oi < b.orders.sizes.length; oi++) {
      inRangeBig(`bulkOrders.bulks[${bi}].sizes[${oi}]`, b.orders.sizes[oi], e.sizeMin, e.sizeMax);
      inRangeNum(`bulkOrders.bulks[${bi}].limitTicks[${oi}]`, b.orders.limitTicks[oi], e.tickMin, e.tickMax);
    }
  }
}

interface DecodedBulkCancelsArgs {
  args: readonly [{ cross: boolean; marketId: number; cancelAll: boolean; orderIds: readonly bigint[] }];
}

function verifyBulkCancels(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_BULK_CANCELS], data: calldata }) as unknown as DecodedBulkCancelsArgs;
  const req = decoded.args[0];
  if (e.cross !== undefined) eq('bulkCancels.cross', req.cross, e.cross);
  if (e.marketId !== undefined) eq('bulkCancels.marketId', req.marketId, e.marketId);
  if (e.marketAcc !== undefined) {
    eq('bulkCancels.marketId (vs marketAcc)', req.marketId, marketIdFromMarketAcc(e.marketAcc));
  }
  if (e.orderIdsSubset !== undefined) {
    // Caller pinned a subset → reject sweep.
    if (req.cancelAll) mismatch('bulkCancels.cancelAll=true but caller pinned orderIdsSubset');
    const allowed = new Set(e.orderIdsSubset.map((x) => x.toString()));
    for (const id of req.orderIds) {
      if (!allowed.has(id.toString())) {
        mismatch(`bulkCancels.orderIds contains ${id.toString()} not in caller's subset`);
      }
    }
  }
}

interface DecodedCashTransferArgs {
  args: readonly [{ marketId: number; signedAmount: bigint }];
}

function verifyCashTransfer(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_CASH_TRANSFER], data: calldata }) as unknown as DecodedCashTransferArgs;
  const req = decoded.args[0];
  if (e.marketId !== undefined) eq('cashTransfer.marketId', req.marketId, e.marketId);
  if (e.marketAcc !== undefined) {
    eq('cashTransfer.marketId (vs marketAcc)', req.marketId, marketIdFromMarketAcc(e.marketAcc));
  }
  if (e.signedAmountExact !== undefined) eqBig('cashTransfer.signedAmount', req.signedAmount, e.signedAmountExact);
  inRangeBig('cashTransfer.signedAmount', req.signedAmount, e.signedAmountMin, e.signedAmountMax);
}

interface DecodedPayTreasuryArgs {
  args: readonly [{ cross: boolean; marketId: number; amount: bigint }];
}

function verifyPayTreasury(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_PAY_TREASURY], data: calldata }) as unknown as DecodedPayTreasuryArgs;
  const req = decoded.args[0];
  if (e.cross !== undefined) eq('payTreasury.cross', req.cross, e.cross);
  if (e.marketId !== undefined) eq('payTreasury.marketId', req.marketId, e.marketId);
  if (e.marketAcc !== undefined) {
    eq('payTreasury.marketId (vs marketAcc)', req.marketId, marketIdFromMarketAcc(e.marketAcc));
  }
  if (e.amountExact !== undefined) eqBig('payTreasury.amount', req.amount, e.amountExact);
  inRangeBig('payTreasury.amount', req.amount, e.amountMin, e.amountMax);
}

interface DecodedEnterExitArgs {
  args: readonly [{ cross: boolean; isEnter: boolean; marketIds: readonly number[] }];
}

function verifyEnterExitMarkets(calldata: Hex, e: IntentExpectation): void {
  const decoded = decodeFunctionData({ abi: [ABI_ENTER_EXIT_MARKETS], data: calldata }) as unknown as DecodedEnterExitArgs;
  const req = decoded.args[0];
  if (e.cross !== undefined) eq('enterExitMarkets.cross', req.cross, e.cross);
  if (e.isEnter !== undefined) eq('enterExitMarkets.isEnter', req.isEnter, e.isEnter);
  if (e.marketIdsSet !== undefined) {
    const want = new Set(e.marketIdsSet);
    if (req.marketIds.length !== want.size) {
      mismatch(
        `enterExitMarkets.marketIds count: calldata=${req.marketIds.length}, expected=${want.size}`,
      );
    }
    for (const m of req.marketIds) {
      if (!want.has(m)) mismatch(`enterExitMarkets.marketIds contains ${m} not in caller's set`);
    }
  }
}

/**
 * Verify a calldata against caller's expected intent. Throws (INVALID_PARAMS) on mismatch.
 * No-op for AMM ops (selector-only via assertCalldatasAllowed upstream).
 */
export function verifyCalldataIntent(calldata: Hex, expect: IntentExpectation): void {
  if (!calldata || typeof calldata !== 'string' || !calldata.startsWith('0x') || calldata.length < 10) {
    mismatch(`malformed calldata: ${String(calldata).slice(0, 16)}…`);
  }
  const sel = calldata.slice(0, 10).toLowerCase();
  if (expect.selector && expect.selector.toLowerCase() !== sel) {
    mismatch(`selector: calldata=${sel}, expected=${expect.selector.toLowerCase()}`);
  }

  switch (sel) {
    case ROUTER_SELECTORS.placeSingleOrder: return verifyPlaceSingleOrder(calldata, expect);
    case ROUTER_SELECTORS.bulkOrders: return verifyBulkOrders(calldata, expect);
    case ROUTER_SELECTORS.bulkCancels: return verifyBulkCancels(calldata, expect);
    case ROUTER_SELECTORS.cashTransfer: return verifyCashTransfer(calldata, expect);
    case ROUTER_SELECTORS.payTreasury: return verifyPayTreasury(calldata, expect);
    case ROUTER_SELECTORS.enterExitMarkets: return verifyEnterExitMarkets(calldata, expect);
    // Deferred — selector-only via assertCalldatasAllowed upstream.
    case ROUTER_SELECTORS.ammCashTransfer:
    case ROUTER_SELECTORS.swapWithAmm:
    case ROUTER_SELECTORS.addLiquidityDualToAmm:
    case ROUTER_SELECTORS.addLiquiditySingleCashToAmm:
    case ROUTER_SELECTORS.removeLiquidityDualFromAmm:
    case ROUTER_SELECTORS.removeLiquiditySingleCashFromAmm:
      return;
    default:
      mismatch(`no intent verifier registered for selector ${sel}`);
  }
}
