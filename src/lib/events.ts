import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GatewayEvent } from "./types";

export function listenGatewayEvents(
  handler: (event: GatewayEvent) => void
): Promise<UnlistenFn> {
  return listen<GatewayEvent>("gateway://events", (e) => handler(e.payload));
}
