import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { addDays, assertSpan, dateStr, isoDate, parseDate, stripNulls } from "../toolkit";
import { encodeWeightFit } from "../fit";

const WEIGHT = "/weight-service";
const MENSTRUAL = "/periodichealth-service/menstrualcycle";
const COURSE = "/course-service/course";
const MENSTRUAL_MAX_DAYS = 92;
const MENSTRUAL_MAX_CHUNKS = 20;

const round2 = (n: number) => Math.round(n * 100) / 100;

// mirrors Python's `if not data` falsy check
const isEmpty = (v: unknown) =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && Object.keys(v as object).length === 0);

// Garmin expects "YYYY-MM-DDThh:mm:ss.sss" with no zone; worker "local" time is UTC
const fmtTs = (d: Date) => d.toISOString().slice(0, 23);

function parseTs(s: string): Date {
  const d = new Date(s.endsWith("Z") ? s : `${s}Z`);
  if (isNaN(d.getTime())) throw new Error(`invalid timestamp: ${s}`);
  return d;
}

function curateMeasurement(w: Record<string, any>): Record<string, any> {
  return stripNulls({
    weight_grams: w.weight,
    weight_kg: w.weight ? round2(w.weight / 1000) : null,
    bmi: w.bmi,
    body_fat_percent: w.bodyFat,
    body_water_percent: w.bodyWater,
    bone_mass_grams: w.boneMass,
    muscle_mass_grams: w.muscleMass,
    source_type: w.sourceType,
    timestamp_gmt: w.timestampGMT,
  });
}

function appendAverage(curated: Record<string, any>, data: Record<string, any>) {
  const avg = data?.totalAverage ?? {};
  if (avg.weight) {
    curated.average_weight_grams = avg.weight;
    curated.average_weight_kg = round2(avg.weight / 1000);
  }
}

const unitKeyParam = z
  .enum(["kg", "lbs"])
  .default("kg")
  .describe("Unit of weight ('kg' or 'lbs')");

async function postWeighIn(
  ctx: Ctx,
  weight: number,
  unitKey: string,
  dateTs: string,
  gmtTs: string
) {
  return ctx.api(`${WEIGHT}/user-weight`, {
    method: "POST",
    body: {
      dateTimestamp: dateTs,
      gmtTimestamp: gmtTs,
      unitKey,
      sourceType: "MANUAL",
      value: weight,
    },
  });
}

// --- menstrual calendar stitching (shape-tolerant, mirrors the Python) ---
function stitchMenstrualChunks(chunks: any[]): any {
  if (chunks.length === 1) return chunks[0];
  if (chunks.every((c) => Array.isArray(c))) return chunks.flat();
  const isDictOfLists = (c: any) =>
    c && typeof c === "object" && !Array.isArray(c) && Object.values(c).every(Array.isArray);
  if (chunks.every(isDictOfLists)) {
    const stitched: Record<string, any[]> = {};
    for (const c of chunks)
      for (const [k, v] of Object.entries(c)) (stitched[k] ??= []).push(...(v as any[]));
    return stitched;
  }
  return chunks;
}

// --- course geometry ---
type Geo = Record<string, any>;
const EARTH_RADIUS_M = 6371000;
const rad = (deg: number) => (deg * Math.PI) / 180;

function haversine(p1: Geo, p2: Geo): number {
  const lat1 = rad(p1.latitude);
  const lat2 = rad(p2.latitude);
  const dlat = lat2 - lat1;
  const dlon = rad(p2.longitude) - rad(p1.longitude);
  const a =
    Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function initialBearing(p1: Geo, p2: Geo): number {
  const lat1 = rad(p1.latitude);
  const lat2 = rad(p2.latitude);
  const dlon = rad(p2.longitude - p1.longitude);
  const x = Math.sin(dlon) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

const ACTIVITY_TYPE_IDS: Record<string, number> = {
  running: 1,
  cycling: 2,
  hiking: 3,
  walking: 9,
  trail_running: 6,
  mountain_biking: 5,
  road_biking: 10,
  gravel_cycling: 4,
};

// Construct the create-course JSON body from the /import response
function buildCoursePayload(
  parsed: Record<string, any>,
  courseName: string,
  activityTypeId: number,
  description: string | null
): Record<string, any> {
  const geoPoints: Geo[] = [...(parsed.geoPoints ?? [])];
  if (geoPoints.length < 2)
    throw new Error("Parsed course has fewer than 2 geo points; GPX is empty or invalid");

  let totalDistance = 0;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  geoPoints.forEach((p, i) => {
    if (i > 0) totalDistance += haversine(geoPoints[i - 1], p);
    p.distance = totalDistance;
    if (p.elevation == null) p.elevation = 0;
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
  });

  const first = geoPoints[0];
  const last = geoPoints[geoPoints.length - 1];

  return {
    courseName,
    description,
    openStreetMap: false,
    matchedToSegments: false,
    userProfilePk: null,
    userGroupPk: null,
    rulePK: 2, // private
    geoRoutePk: null,
    sourceTypeId: 3, // GPX
    sourcePk: null,
    distanceMeter: totalDistance,
    elevationGainMeter: 0,
    elevationLossMeter: 0,
    startPoint: {
      latitude: first.latitude,
      longitude: first.longitude,
      elevation: first.elevation ?? 0,
      distance: null,
      timestamp: null,
    },
    coursePoints: [],
    boundingBox: {
      center: { latitude: (minLat + maxLat) / 2, longitude: (minLon + maxLon) / 2 },
      lowerLeft: { latitude: minLat, longitude: minLon },
      upperRight: { latitude: maxLat, longitude: maxLon },
      lowerLeftLatIsSet: true,
      lowerLeftLongIsSet: true,
      upperRightLatIsSet: true,
      upperRightLongIsSet: true,
    },
    hasShareableEvent: false,
    hasTurnDetectionDisabled: false,
    activityTypePk: activityTypeId,
    virtualPartnerId: null,
    includeLaps: false,
    elapsedSeconds: null,
    speedMeterPerSecond: null,
    courseLines: [
      {
        courseId: null,
        sortOrder: 1,
        numberOfPoints: geoPoints.length,
        distanceInMeters: totalDistance,
        bearing: initialBearing(first, last),
        points: geoPoints,
        coordinateSystem: "WGS84",
        originalCoordinateSystem: "WGS84",
      },
    ],
    coordinateSystem: "WGS84",
    targetCoordinateSystem: "WGS84",
    originalCoordinateSystem: "WGS84",
    consumer: null,
    elevationSource: 3,
    hasPaceBand: false,
    hasPowerGuide: false,
    favorite: false,
    startNote: null,
    finishNote: null,
    cutoffDuration: null,
    geoPoints,
  };
}

export const tools: ToolDef[] = [
  // --- weight management ---
  {
    name: "get_weigh_ins",
    desc: "Get weight measurements between specified dates",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const data = (await ctx.api(
        `${WEIGHT}/weight/range/${args.start_date}/${args.end_date}`,
        { params: { includeAll: "true" } }
      )) as Record<string, any>;
      const summaries: Record<string, any>[] = data?.dailyWeightSummaries ?? [];
      if (summaries.length === 0)
        return `No weight measurements found between ${args.start_date} and ${args.end_date}.`;

      const all = summaries.flatMap((d) => (d.allWeightMetrics ?? []) as Record<string, any>[]);
      const measurements = all
        .map((w) => ({ date: w.calendarDate, ...curateMeasurement(w) }))
        .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));

      const curated: Record<string, any> = {
        date_range: { start: args.start_date, end: args.end_date },
        measurement_count: all.length,
        days_with_data: summaries.length,
        measurements,
      };
      appendAverage(curated, data);
      return curated;
    },
  },
  {
    name: "get_daily_weigh_ins",
    desc: "Get weight measurements for a specific date",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const data = (await ctx.api(`${WEIGHT}/weight/dayview/${args.date}`, {
        params: { includeAll: "true" },
      })) as Record<string, any>;
      const list: Record<string, any>[] = data?.dateWeightList ?? [];
      if (list.length === 0) return `No weight measurements found for ${args.date}.`;

      const curated: Record<string, any> = {
        date: args.date,
        measurement_count: list.length,
        measurements: list.map(curateMeasurement),
      };
      appendAverage(curated, data);
      return curated;
    },
  },
  {
    name: "delete_weigh_ins",
    desc: "Delete weight measurements for a specific date",
    params: {
      date: dateStr,
      delete_all: z
        .boolean()
        .default(true)
        .describe("Whether to delete all measurements for the day"),
    },
    run: async (args, ctx) => {
      const day = (await ctx.api(`${WEIGHT}/weight/dayview/${args.date}`, {
        params: { includeAll: "true" },
      })) as Record<string, any>;
      const list: Record<string, any>[] = day?.dateWeightList ?? [];
      if (list.length === 0)
        return {
          status: "success",
          date: args.date,
          deleted_count: 0,
          message: `No weigh-ins found on ${args.date}`,
        };
      if (list.length > 1 && !args.delete_all)
        return {
          status: "refused",
          date: args.date,
          deleted_count: 0,
          message: `Found ${list.length} weigh-ins on ${args.date}; set delete_all=true to delete them all`,
        };
      for (const w of list)
        await ctx.api(`${WEIGHT}/weight/${args.date}/byversion/${w.samplePk}`, {
          method: "DELETE",
        });
      return {
        status: "success",
        date: args.date,
        deleted_count: list.length,
        message: `Weight measurements deleted for ${args.date}`,
      };
    },
  },
  {
    name: "add_weigh_in",
    desc: "Add a new weight measurement",
    params: {
      weight: z.number().positive().describe("Weight value"),
      unit_key: unitKeyParam,
    },
    run: async (args, ctx) => {
      const ts = fmtTs(new Date());
      await postWeighIn(ctx, args.weight, args.unit_key, ts, ts);
      return {
        status: "success",
        weight: args.weight,
        unit: args.unit_key,
        message: "Weight measurement added successfully",
      };
    },
  },
  {
    name: "add_weigh_in_with_timestamps",
    desc: "Add a new weight measurement with specific timestamps",
    params: {
      weight: z.number().positive().describe("Weight value"),
      unit_key: unitKeyParam,
      date_timestamp: z
        .string()
        .optional()
        .describe("Local timestamp in format YYYY-MM-DDThh:mm:ss"),
      gmt_timestamp: z
        .string()
        .optional()
        .describe("GMT timestamp in format YYYY-MM-DDThh:mm:ss"),
    },
    run: async (args, ctx) => {
      let { date_timestamp, gmt_timestamp } = args as {
        date_timestamp?: string;
        gmt_timestamp?: string;
      };
      if (!date_timestamp || !gmt_timestamp) {
        const now = new Date().toISOString().slice(0, 19);
        date_timestamp = now;
        gmt_timestamp = now;
      }
      await postWeighIn(
        ctx,
        args.weight,
        args.unit_key,
        fmtTs(parseTs(date_timestamp)),
        fmtTs(parseTs(gmt_timestamp))
      );
      return {
        status: "success",
        weight: args.weight,
        unit: args.unit_key,
        timestamp_local: date_timestamp,
        timestamp_gmt: gmt_timestamp,
        message: "Weight measurement added successfully",
      };
    },
  },
  // --- data management ---
  {
    name: "add_body_composition",
    desc: "Add body composition data",
    params: {
      date: dateStr,
      weight: z.number().positive().describe("Weight in kg"),
      percent_fat: z.number().optional().describe("Body fat percentage"),
      percent_hydration: z.number().optional().describe("Hydration percentage"),
      visceral_fat_mass: z.number().optional().describe("Visceral fat mass"),
      bone_mass: z.number().optional().describe("Bone mass"),
      muscle_mass: z.number().optional().describe("Muscle mass"),
      basal_met: z.number().optional().describe("Basal metabolic rate"),
      active_met: z.number().optional().describe("Active metabolic rate"),
      physique_rating: z.number().int().optional().describe("Physique rating"),
      metabolic_age: z.number().optional().describe("Metabolic age"),
      visceral_fat_rating: z.number().int().optional().describe("Visceral fat rating"),
      bmi: z.number().optional().describe("Body Mass Index"),
    },
    run: async (args, ctx) => {
      const { date, ...fields } = args as Record<string, any>;
      const fit = encodeWeightFit(parseDate(date).getTime() / 1000, fields as any);
      return ctx.api("/upload-service/upload", {
        method: "POST",
        form: {
          file: {
            filename: "body_composition.fit",
            content: fit,
            type: "application/octet-stream",
          },
        },
      });
    },
  },
  {
    name: "set_blood_pressure",
    desc: "Set blood pressure values",
    params: {
      systolic: z.number().int().min(70).max(260).describe("Systolic pressure (top number)"),
      diastolic: z.number().int().min(40).max(150).describe("Diastolic pressure (bottom number)"),
      pulse: z.number().int().min(20).max(250).describe("Pulse rate"),
      notes: z.string().optional().describe("Optional notes"),
    },
    run: (args, ctx) => {
      const ts = fmtTs(new Date());
      return ctx.api("/bloodpressure-service/bloodpressure", {
        method: "POST",
        body: {
          measurementTimestampLocal: ts,
          measurementTimestampGMT: ts,
          systolic: args.systolic,
          diastolic: args.diastolic,
          pulse: args.pulse,
          sourceType: "MANUAL",
          notes: args.notes ?? "",
        },
      });
    },
  },
  {
    name: "add_hydration_data",
    desc: "Add hydration data",
    params: {
      value_in_ml: z
        .number()
        .int()
        .describe("Amount of liquid in milliliters (negative to subtract)"),
      cdate: dateStr,
      timestamp: z.string().describe("Timestamp in YYYY-MM-DDThh:mm:ss.sss format"),
    },
    run: (args, ctx) => {
      if (Math.abs(args.value_in_ml) > 10000)
        throw new Error("value_in_ml seems unreasonably high (>10000ml)");
      const ts = fmtTs(parseTs(args.timestamp));
      if (ts.slice(0, 10) !== args.cdate)
        throw new Error(`timestamp date (${ts.slice(0, 10)}) doesn't match cdate (${args.cdate})`);
      return ctx.api("/usersummary-service/usersummary/hydration/log", {
        method: "PUT",
        body: { calendarDate: args.cdate, timestampLocal: ts, valueInML: args.value_in_ml },
      });
    },
  },
  // --- women's health ---
  {
    name: "get_pregnancy_summary",
    desc: "Get pregnancy summary data",
    run: async (_args, ctx) => {
      const summary = await ctx.api(`${MENSTRUAL}/pregnancysnapshot`);
      if (isEmpty(summary)) return "No pregnancy summary data found.";
      return summary;
    },
  },
  {
    name: "get_menstrual_data_for_date",
    desc: "Get menstrual data for a specific date",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const data = await ctx.api(`${MENSTRUAL}/dayview/${args.date}`);
      if (isEmpty(data)) return `No menstrual data found for ${args.date}.`;
      return data;
    },
  },
  {
    name: "get_menstrual_calendar_data",
    desc: "Get menstrual calendar data between specified dates. Automatically chunks requests longer than 92 days, Garmin's server-side limit, and stitches the responses together.",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      assertSpan(args.start_date, args.end_date, MENSTRUAL_MAX_DAYS * MENSTRUAL_MAX_CHUNKS);
      const end = parseDate(args.end_date);
      const chunks: any[] = [];
      for (let cursor = parseDate(args.start_date); cursor <= end; ) {
        const windowEnd = new Date(
          Math.min(addDays(cursor, MENSTRUAL_MAX_DAYS - 1).getTime(), end.getTime())
        );
        const data = await ctx.api(
          `${MENSTRUAL}/calendar/${isoDate(cursor)}/${isoDate(windowEnd)}`
        );
        if (!isEmpty(data)) chunks.push(data);
        cursor = addDays(windowEnd, 1);
      }
      if (chunks.length === 0)
        return `No menstrual calendar data found between ${args.start_date} and ${args.end_date}.`;
      return stitchMenstrualChunks(chunks);
    },
  },
  // --- courses ---
  {
    name: "get_courses",
    desc: "List all courses saved on Garmin Connect. Returns a curated list of courses with id, name, distance, activity type and creation date.",
    run: async (_args, ctx) => {
      const data = await ctx.api(COURSE);
      if (!Array.isArray(data)) return data;
      const courses = (data as Record<string, any>[]).map((c) => ({
        course_id: c.courseId,
        name: c.courseName,
        distance_m: c.distanceInMeters,
        elevation_gain_m: c.elevationGainInMeters,
        elevation_loss_m: c.elevationLossInMeters,
        activity: c.activityType?.typeKey,
        has_pace_band: c.hasPaceBand,
        created: c.createdDateFormatted,
      }));
      return { count: courses.length, courses };
    },
  },
  {
    name: "upload_course",
    desc: 'Upload a GPX course to Garmin Connect. The course can then be loaded onto the watch (sync or "Send to Device") and used as a navigation course or to build a PacePro strategy.',
    params: {
      gpx_content: z
        .string()
        .describe(
          "The GPX file content as XML text. This server is remote and cannot read files from disk, so pass the full GPX XML here."
        ),
      course_name: z
        .string()
        .optional()
        .describe("Override the course name. Defaults to the name parsed from the GPX file."),
      activity_type: z
        .string()
        .default("running")
        .describe(
          "One of running, cycling, hiking, walking, trail_running, mountain_biking, road_biking, gravel_cycling. Defaults to running."
        ),
      description: z
        .string()
        .optional()
        .describe("Optional description shown on the course detail page."),
    },
    run: async (args, ctx) => {
      const activityTypeId = ACTIVITY_TYPE_IDS[args.activity_type.toLowerCase()];
      if (activityTypeId === undefined)
        throw new Error(
          `unknown activity_type '${args.activity_type}'. Supported: ${Object.keys(ACTIVITY_TYPE_IDS).sort().join(", ")}.`
        );
      if (!args.gpx_content.includes("<gpx"))
        throw new Error("gpx_content does not look like GPX XML (no <gpx> element)");

      // Step 1: parse the GPX server-side
      const parsed = (await ctx.api(`${COURSE}/import`, {
        method: "POST",
        form: {
          file: {
            filename: "course.gpx",
            content: args.gpx_content,
            type: "application/gpx+xml",
          },
        },
      })) as Record<string, any>;

      const effectiveName = args.course_name || parsed?.courseName || "Imported course";

      // Step 2: build the create payload and save
      const payload = buildCoursePayload(
        parsed,
        effectiveName,
        activityTypeId,
        args.description ?? null
      );
      const saved = (await ctx.api(COURSE, { method: "POST", body: payload })) as Record<
        string,
        any
      >;
      return {
        status: "success",
        course_id: saved.courseId,
        name: saved.courseName,
        distance_m: saved.distanceMeter,
        elevation_gain_m: saved.elevationGainMeter,
        elevation_loss_m: saved.elevationLossMeter,
        activity_type_id: saved.activityTypePk,
        url: `https://connect.garmin.com/modern/course/${saved.courseId}`,
      };
    },
  },
  {
    name: "delete_course",
    desc: "Delete a course from Garmin Connect.",
    params: {
      course_id: z.number().int().describe("ID of the course to delete (get IDs from get_courses)"),
    },
    run: async (args, ctx) => {
      await ctx.api(`${COURSE}/${args.course_id}`, { method: "DELETE" });
      return {
        status: "success",
        course_id: args.course_id,
        message: `Course ${args.course_id} deleted`,
      };
    },
  },
];
