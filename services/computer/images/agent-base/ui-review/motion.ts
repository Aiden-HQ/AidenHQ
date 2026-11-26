// Placeholder until lane B's motion measurements merge (it replaces this file): passive, never clicks.
import type { Page as PwPage } from "playwright-core";
import type { Motion } from "./types.ts";

export async function measureMotion(_page: PwPage): Promise<Motion> {
  return { transitions: [], animations: [], hover: [], active: [], keyframes: [], longFrames: [], shifts: [] };
}
