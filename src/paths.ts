import { homedir } from "node:os";
import { resolve } from "node:path";

export function stateRoot(): string {
  return resolve(
    process.env.OPENPAPER_RELAY_STATE_DIR ??
      resolve(homedir(), ".local", "share", "openpaper-relay"),
  );
}

export function configPath(): string {
  return resolve(process.env.OPENPAPER_RELAY_CONFIG ?? "sites.local.json");
}
