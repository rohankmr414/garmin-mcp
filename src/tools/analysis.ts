import { z } from "zod";
import { Buffer } from "node:buffer";
import { Decoder, Stream } from "@garmin/fitsdk";
import type { Ctx, ToolDef } from "../toolkit";
import { idParam, isoDate } from "../toolkit";

const PDC_DURATIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 480, 600, 1200, 1800, 2700, 3600];

interface Bin {
  base64: string;
  contentType: string;
}

function b64Bytes(b: Bin): Uint8Array {
  return new Uint8Array(Buffer.from(b.base64, "base64"));
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const resp = new Response(new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await resp.arrayBuffer());
}

// Garmin ORIGINAL downloads are single-file ZIPs; also accept bare FIT bytes
async function extractFit(buf: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 4 || dv.getUint32(0, true) !== 0x04034b50) return buf;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("corrupt zip: no end-of-central-directory");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  let chosen: { method: number; compSize: number; localOffset: number } | undefined;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    const entry = {
      method: dv.getUint16(off + 10, true),
      compSize: dv.getUint32(off + 20, true),
      localOffset: dv.getUint32(off + 42, true),
    };
    if (!chosen || name.toLowerCase().endsWith(".fit")) chosen = entry;
    if (name.toLowerCase().endsWith(".fit")) break;
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (!chosen) throw new Error("zip has no entries");
  const lo = chosen.localOffset;
  const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
  const data = buf.subarray(dataStart, dataStart + chosen.compSize);
  return chosen.method === 8 ? inflateRaw(data) : data;
}

function decodeFit(fit: Uint8Array): Record<string, Record<string, unknown>[]> {
  const decoder = new Decoder(Stream.fromByteArray(fit));
  if (!decoder.isFIT()) throw new Error("not a FIT file");
  const { messages } = decoder.read({ convertDateTimesToDates: false });
  return messages;
}

async function downloadOriginalFit(ctx: Ctx, activityId: number): Promise<Uint8Array> {
  const bin = (await ctx.api(`/download-service/files/activity/${activityId}`, {
    binary: true,
  })) as Bin;
  return extractFit(b64Bytes(bin));
}

// resample records to a 1s power series; gaps count as 0W (coasting)
function powerSeries(records: Record<string, unknown>[]): number[] {
  const pts = records
    .filter((r) => typeof r.power === "number" && typeof r.timestamp === "number")
    .map((r) => ({ t: r.timestamp as number, p: r.power as number }));
  if (pts.length < 2) return [];
  const t0 = pts[0].t;
  const len = Math.min(pts[pts.length - 1].t - t0 + 1, 6 * 3600);
  const series = new Array(len).fill(0);
  for (const { t, p } of pts) {
    const i = t - t0;
    if (i >= 0 && i < len) series[i] = p;
  }
  return series;
}

function bestAverages(series: number[]): Record<string, number> {
  const prefix = new Array(series.length + 1).fill(0);
  for (let i = 0; i < series.length; i++) prefix[i + 1] = prefix[i] + series[i];
  const out: Record<string, number> = {};
  for (const d of PDC_DURATIONS) {
    if (d > series.length) break;
    let best = 0;
    for (let i = 0; i + d <= series.length; i++) {
      best = Math.max(best, (prefix[i + d] - prefix[i]) / d);
    }
    out[label(d)] = Math.round(best);
  }
  return out;
}

function label(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}min`;
}

function normalizedPower(series: number[]): number | null {
  if (series.length < 30) return null;
  let sum = 0;
  for (let i = 0; i < 30; i++) sum += series[i];
  let quartSum = Math.pow(sum / 30, 4);
  let n = 1;
  for (let i = 30; i < series.length; i++) {
    sum += series[i] - series[i - 30];
    quartSum += Math.pow(sum / 30, 4);
    n++;
  }
  return Math.round(Math.pow(quartSum / n, 0.25));
}

async function riderWeightKg(ctx: Ctx, date: string): Promise<number | null> {
  try {
    const body = (await ctx.api("/weight-service/weight/dateRange", {
      params: { startDate: date, endDate: date },
    })) as Record<string, any>;
    const grams = body?.totalAverage?.weight;
    if (grams) return grams / 1000;
    const settings = (await ctx.api("/userprofile-service/userprofile/user-settings")) as Record<string, any>;
    return settings?.userData?.weight ? settings.userData.weight / 1000 : null;
  } catch {
    return null;
  }
}

// FIT epoch offset to unix seconds
const FIT_EPOCH = 631065600;

export const tools: ToolDef[] = [
  {
    name: "get_activity_fit_data",
    desc: "Download and parse the FIT file for an activity: session and lap data plus power analysis (normalized power, variability index, power duration curve, W/kg). Remote port: advanced Di2 shift/climb/HRV analytics from the original local server are not included; use include_records for downsampled raw records.",
    params: {
      activity_id: idParam,
      include_records: z.boolean().default(false).describe("Include up to 500 downsampled records"),
    },
    run: async (args, ctx) => {
      const fit = await downloadOriginalFit(ctx, Number(args.activity_id));
      const messages = decodeFit(fit);
      const session = messages.sessionMesgs?.[0] ?? null;
      const laps = messages.lapMesgs ?? [];
      const records = messages.recordMesgs ?? [];
      const series = powerSeries(records);
      const avg = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
      const np = normalizedPower(series);
      const startUnix = session?.startTime ? (session.startTime as number) + FIT_EPOCH : null;
      const date = startUnix ? isoDate(new Date(startUnix * 1000)) : null;
      const weightKg = date ? await riderWeightKg(ctx, date) : null;

      const result: Record<string, unknown> = {
        activity_id: args.activity_id,
        date,
        session,
        laps,
        record_count: records.length,
        power_analysis: series.length
          ? {
              avg_power: Math.round(avg),
              normalized_power: np,
              variability_index: np && avg ? Math.round((np / avg) * 100) / 100 : null,
              work_kj: Math.round(series.reduce((a, b) => a + b, 0) / 1000),
              power_duration_curve: bestAverages(series),
              ...(weightKg
                ? { rider_weight_kg: weightKg, avg_wkg: Math.round((avg / weightKg) * 100) / 100 }
                : {}),
            }
          : null,
      };
      if (args.include_records && records.length) {
        const step = Math.max(1, Math.ceil(records.length / 500));
        result.records = records
          .filter((_, i) => i % step === 0)
          .map((r) => ({
            timestamp: r.timestamp,
            power: r.power,
            heart_rate: r.heartRate,
            cadence: r.cadence,
            speed: r.enhancedSpeed ?? r.speed,
            altitude: r.enhancedAltitude ?? r.altitude,
            distance: r.distance,
            temperature: r.temperature,
          }));
      }
      return result;
    },
  },
  {
    name: "get_power_duration_curve",
    desc: "Season-best power duration curve across recent cycling activities, with an FTP estimate (95% of best 20min). Remote port: num_activities capped at 15 (was 20) for the serverless request budget.",
    params: {
      num_activities: z.number().int().min(1).max(15).default(10),
      activity_type: z.string().default("cycling").describe("Only cycling-type activities are analyzed"),
    },
    run: async (args, ctx) => {
      const acts = (await ctx.api("/activitylist-service/activities/search/activities", {
        params: { start: "0", limit: String(args.num_activities) },
      })) as Record<string, any>[];
      const cycling = acts.filter((a) => {
        const key = (a.activityType?.typeKey ?? "").toLowerCase();
        return key.includes("cycling") || key.includes("biking") || key.includes("ride") || a.activityType?.parentTypeId === 2;
      });
      const best: Record<string, { watts: number; activity_id: number; date: string }> = {};
      let processed = 0;
      let skipped = 0;
      for (const a of cycling) {
        try {
          const fit = await downloadOriginalFit(ctx, a.activityId);
          const series = powerSeries(decodeFit(fit).recordMesgs ?? []);
          if (!series.length) {
            skipped++;
            continue;
          }
          processed++;
          for (const [dur, watts] of Object.entries(bestAverages(series))) {
            if (!best[dur] || watts > best[dur].watts) {
              best[dur] = { watts, activity_id: a.activityId, date: a.startTimeLocal?.slice(0, 10) };
            }
          }
        } catch {
          skipped++;
        }
      }
      const twenty = best["20min"]?.watts;
      return {
        activities_considered: cycling.length,
        activities_processed: processed,
        activities_skipped: skipped,
        power_duration_curve: best,
        ftp_estimate_watts: twenty ? Math.round(twenty * 0.95) : null,
      };
    },
  },
  {
    name: "download_activity_file",
    desc: "Download an activity file. Remote port: instead of writing to disk, returns the file inline — fit as base64, gpx/tcx/csv as text. Large files are refused with their size.",
    params: {
      activity_id: idParam,
      format: z.enum(["fit", "gpx", "tcx", "csv"]).default("fit"),
    },
    run: async (args, ctx) => {
      const id = Number(args.activity_id);
      if (args.format === "fit") {
        const fit = await downloadOriginalFit(ctx, id);
        if (fit.length > 4 * 1024 * 1024) {
          return { status: "too_large", size_bytes: fit.length, message: "FIT over 4MB; not returned inline" };
        }
        return {
          activity_id: id,
          format: "fit",
          size_bytes: fit.length,
          content_base64: Buffer.from(fit).toString("base64"),
        };
      }
      const bin = (await ctx.api(`/download-service/export/${args.format}/activity/${id}`, {
        binary: true,
      })) as Bin;
      const bytes = b64Bytes(bin);
      if (bytes.length > 1024 * 1024) {
        return { status: "too_large", size_bytes: bytes.length, message: "file over 1MB; not returned inline" };
      }
      return {
        activity_id: id,
        format: args.format,
        size_bytes: bytes.length,
        content: new TextDecoder().decode(bytes),
      };
    },
  },
  {
    name: "set_fit_download_dir",
    desc: "Set the default download directory (no-op on this remote deployment; kept for compatibility with the original local server)",
    params: { path: z.string() },
    run: async (args) => ({
      status: "not_supported",
      message: `This server runs remotely on Cloudflare Workers and cannot write to local disk. Use download_activity_file, which returns file content inline. (requested path: ${args.path})`,
    }),
  },
];
