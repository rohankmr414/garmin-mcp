import { z } from "zod";
import type { ApiOptions } from "./garmin";

export interface Ctx {
  api: (path: string, opts?: ApiOptions) => Promise<unknown>;
  displayName: () => Promise<string>;
}

export interface ToolDef {
  name: string;
  desc: string;
  params?: z.ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, ctx: Ctx) => Promise<unknown>;
}

export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

export const idParam = z.union([z.string(), z.number()]).describe("Activity/entity id");

export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripNulls) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, stripNulls(v)])
    ) as T;
  }
  return value;
}

export function parseDate(s: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// inclusive span in days; throws when inverted or over maxDays
export function assertSpan(start: string, end: string, maxDays: number): number {
  const days = (parseDate(end).getTime() - parseDate(start).getTime()) / 86400000 + 1;
  if (days < 1) throw new Error("start_date must be <= end_date");
  if (days > maxDays) throw new Error(`date range too large: max ${maxDays} days`);
  return days;
}

export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = parseDate(start); d <= parseDate(end); d = addDays(d, 1)) out.push(isoDate(d));
  return out;
}
