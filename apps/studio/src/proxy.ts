// No-op proxy. Prevents Next 16 from picking up a proxy.ts higher in the
// monorepo (the orchestrator's auth proxy) when running Studio.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
