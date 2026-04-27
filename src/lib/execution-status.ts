// send-txs-bot returns `{execution:[{status,error},...]}` per sub-call when requireSuccess:false.
// Reverted entries have status:"reverted" with reason in `error`.
export interface ExecutionStatus {
  allSuccess: boolean;
  successCount: number;
  revertCount: number;
  reverts: { index: number; error: string }[];
  entries: any[];
}

export function analyzeExecution(result: any): ExecutionStatus {
  const entries: any[] = Array.isArray(result?.execution)
    ? result.execution
    : Array.isArray(result) ? result : [];
  const reverts: { index: number; error: string }[] = [];
  let successCount = 0;
  entries.forEach((e: any, i: number) => {
    const status = String(e?.status ?? '').toLowerCase();
    if (status === 'reverted' || status === 'failed' || status === 'error') {
      reverts.push({ index: i, error: String(e?.error ?? e?.reason ?? 'reverted') });
    } else {
      successCount++;
    }
  });
  return {
    allSuccess: entries.length > 0 && reverts.length === 0,
    successCount,
    revertCount: reverts.length,
    reverts,
    entries,
  };
}
