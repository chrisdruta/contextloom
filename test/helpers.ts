import { join } from "node:path";
import { type ResolvedSettings, SettingsSchema } from "../src/settings/schema";

export const FIXTURES = join(__dirname, "fixtures");

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function defaultSettings(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return SettingsSchema.parse(overrides);
}
