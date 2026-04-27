// Auth wrapper for MCP tool handlers — short-circuits with requireAuth() error envelope on failure.
import { requireAuth, type RequireAuthOk } from '../agent/require-auth.js';

type AuthedHandler<Args, Ret> = (args: Args, auth: RequireAuthOk) => Promise<Ret>;

export function withAuth<Args, Ret>(handler: AuthedHandler<Args, Ret>) {
  return async (args: Args) => {
    const result = await requireAuth();
    if (!result.ok) return result.error;
    return handler(args, result);
  };
}
