// Use in Zod schemas so malformed addresses are caught at schema layer (actionable msg).
export const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
export const MARKET_ACC_REGEX = /^0x[0-9a-fA-F]{52}$/;
