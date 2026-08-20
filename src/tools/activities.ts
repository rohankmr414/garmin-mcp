import { z } from "zod";
import { dateStr, idParam, stripNulls } from "../toolkit";
import type { Ctx, ToolDef } from "../toolkit";

const ACTIVITY = "/activity-service/activity";
const ACTIVITIES = "/activitylist-service/activities/search/activities";

function actId(id: string | number): number {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid activity_id: ${id}`);
  return n;
}

// Garmin merges a partial ActivityDTO keyed by activityId; send only changed fields
function putActivity(ctx: Ctx, activityId: number, payload: Record<string, any>) {
  return ctx.api(`${ACTIVITY}/${activityId}`, {
    method: "PUT",
    body: { activityId, ...payload },
  });
}

// Never read-modify-write full summaryDTO: PUTting the GPS coordinate pair back 400s
function updateSummary(ctx: Ctx, activityId: number, fields: Record<string, any>) {
  return putActivity(ctx, activityId, { summaryDTO: fields });
}

async function unitSystem(ctx: Ctx): Promise<string | undefined> {
  try {
    const s = (await ctx.api("/userprofile-service/userprofile/user-settings")) as Record<string, any>;
    return s?.userData?.measurementSystem ?? undefined;
  } catch {
    return undefined;
  }
}

function curateListActivity(a: Record<string, any>): Record<string, any> {
  return stripNulls({
    id: a.activityId,
    name: a.activityName,
    type: a.activityType?.typeKey,
    event_type: a.eventType?.typeKey,
    start_time: a.startTimeLocal,
    distance_meters: a.distance,
    duration_seconds: a.duration,
    calories: a.calories,
    avg_hr_bpm: a.averageHR,
    max_hr_bpm: a.maxHR,
    steps: a.steps,
    elevation_gain_meters: a.elevationGain,
    elevation_loss_meters: a.elevationLoss,
  });
}

export const tools: ToolDef[] = [
  {
    name: "get_activities_by_date",
    desc: `Get activities between specified dates with pagination support.

For accounts with large activity histories, broad date ranges can return thousands of activities in a single response. Use page and page_size to retrieve activities in manageable chunks and avoid "result too large" errors. Activities are ordered newest-first.

Pagination: when has_more is true the response includes next_page — pass that value as page on the next call to retrieve the following page. Repeat until has_more is false.

Note: total_count for a date range is not available from the Garmin API without fetching all results. Use has_more / next_page to walk pages.

Each activity includes an event_type field with values such as:
  - "race"          — explicitly tagged as a race by the user
  - "training"      — explicitly tagged as a training activity
  - "uncategorized" — no event type set; common for Peloton imports and untagged outdoor runs. Distinct from "training": filter for races with event_type == "race" rather than excluding "training", since many non-race activities appear as "uncategorized" not "training"
  - field absent    — API returned no eventType for this activity; not observed in practice in any activity back to 2012 (oldest activities sampled on this account)`,
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
      activity_type: z
        .string()
        .default("")
        .describe("Optional activity type filter (e.g., cycling, running, swimming)"),
      page: z.number().int().default(0).describe("Zero-based page number (default 0)"),
      page_size: z
        .number()
        .int()
        .default(100)
        .describe("Number of activities per page, max 200 (default 100)"),
    },
    run: async (args, ctx) => {
      const pageSize = Math.min(Math.max(1, args.page_size), 200);
      const start = args.page * pageSize;
      const activities = ((await ctx.api(ACTIVITIES, {
        params: {
          startDate: args.start_date,
          endDate: args.end_date,
          start: String(start),
          limit: String(pageSize),
          activityType: args.activity_type || undefined,
        },
      })) ?? []) as Record<string, any>[];

      const hasMore = activities.length === pageSize;
      return {
        count: activities.length,
        page: args.page,
        page_size: pageSize,
        has_more: hasMore,
        ...(hasMore ? { next_page: args.page + 1 } : {}),
        date_range: { start: args.start_date, end: args.end_date },
        activities: activities.map(curateListActivity),
      };
    },
  },
  {
    name: "get_activities_fordate",
    desc: "Get activities for a specific date",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const data = (await ctx.api(`/mobile-gateway/heartRate/forDate/${args.date}`)) as Record<
        string,
        any
      > | null;
      const payload: Record<string, any>[] = data?.ActivitiesForDay?.payload ?? [];
      if (!payload.length) return `No activities found for ${args.date}`;
      return {
        date: args.date,
        count: payload.length,
        activities: payload.map((a) =>
          stripNulls({
            id: a.activityId,
            name: a.activityName,
            type: a.activityType?.typeKey,
            event_type: a.eventType?.typeKey,
            start_time: a.startTimeLocal,
            distance_meters: a.distance,
            duration_seconds: a.duration,
            calories: a.calories,
            avg_hr_bpm: a.averageHR,
            steps: a.steps,
            lap_count: a.lapCount,
            moderate_intensity_minutes: a.moderateIntensityMinutes,
            vigorous_intensity_minutes: a.vigorousIntensityMinutes,
          })
        ),
      };
    },
  },
  {
    name: "get_activity",
    desc: `Get detailed information for a single activity.

Returns a comprehensive summary including timing, distance, heart rate, elevation, training effect, and an event_type field. Common event_type values: "race", "training", "uncategorized" (no event type set by the user). The field is omitted for very old activities that pre-date event type support in the Garmin API.`,
    params: { activity_id: idParam.describe("ID of the activity to retrieve") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const activity = (await ctx.api(`${ACTIVITY}/${id}`)) as Record<string, any> | null;
      if (!activity) return `No activity found with ID ${id}`;
      const summary: Record<string, any> = activity.summaryDTO ?? {};
      const activityType: Record<string, any> = activity.activityTypeDTO ?? {};
      const metadata: Record<string, any> = activity.metadataDTO ?? {};
      return stripNulls({
        id: activity.activityId,
        name: activity.activityName,
        description: activity.description,
        type: activityType.typeKey,
        event_type: activity.eventTypeDTO?.typeKey,
        parent_type: activityType.parentTypeId,
        start_time_local: summary.startTimeLocal,
        start_time_gmt: summary.startTimeGMT,
        duration_seconds: summary.duration,
        moving_duration_seconds: summary.movingDuration,
        elapsed_duration_seconds: summary.elapsedDuration,
        distance_meters: summary.distance,
        avg_speed_mps: summary.averageSpeed,
        max_speed_mps: summary.maxSpeed,
        avg_hr_bpm: summary.averageHR,
        max_hr_bpm: summary.maxHR,
        min_hr_bpm: summary.minHR,
        calories: summary.calories,
        bmr_calories: summary.bmrCalories,
        avg_cadence: summary.averageRunCadence,
        max_cadence: summary.maxRunCadence,
        avg_stride_length_cm: summary.strideLength,
        avg_ground_contact_time_ms: summary.groundContactTime,
        avg_vertical_oscillation_cm: summary.verticalOscillation,
        steps: summary.steps,
        avg_power_watts: summary.averagePower,
        max_power_watts: summary.maxPower,
        normalized_power_watts: summary.normalizedPower,
        training_effect: summary.trainingEffect,
        anaerobic_training_effect: summary.anaerobicTrainingEffect,
        training_effect_label: summary.trainingEffectLabel,
        training_load: summary.activityTrainingLoad,
        moderate_intensity_minutes: summary.moderateIntensityMinutes,
        vigorous_intensity_minutes: summary.vigorousIntensityMinutes,
        elevation_gain_meters: summary.elevationGain,
        elevation_loss_meters: summary.elevationLoss,
        max_elevation_meters: summary.maxElevation,
        min_elevation_meters: summary.minElevation,
        recovery_hr_bpm: summary.recoveryHeartRate,
        body_battery_impact: summary.differenceBodyBattery,
        workout_feel: summary.directWorkoutFeel,
        workout_rpe: summary.directWorkoutRpe,
        lap_count: metadata.lapCount,
        has_splits: metadata.hasSplits,
        device_manufacturer: metadata.manufacturer,
      });
    },
  },
  {
    name: "set_activity_name",
    desc: "Set or update the name of an activity.",
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      activity_name: z.string().describe("New activity name"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const name = args.activity_name.trim();
      if (!name) return "Activity name cannot be empty";
      await putActivity(ctx, id, { activityName: name });
      return {
        success: true,
        activity_id: id,
        activity_name: name,
        message: "Activity name successfully updated",
      };
    },
  },
  {
    name: "set_activity_type",
    desc: `Change the activity type (sport) of an activity.

Useful for reclassifying a mislabelled activity, e.g. flipping a run logged as 'trail_running' to 'running', or a 'treadmill_running' walk to 'treadmill_walking'. Call get_activity_types to see all valid type keys.`,
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      type_key: z
        .string()
        .describe(
          "Target activity type key (e.g. 'running', 'trail_running', 'treadmill_running', 'cycling', 'lap_swimming')"
        ),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const typeKey = args.type_key.trim();
      const types = ((await ctx.api(`${ACTIVITY}/activityTypes`)) ?? []) as Record<string, any>[];
      const match = types.find((t) => t.typeKey === typeKey);
      if (!match) {
        const valid = types
          .map((t) => t.typeKey)
          .filter(Boolean)
          .sort()
          .join(", ");
        return `Unknown activity type '${typeKey}'. Valid type keys: ${valid}`;
      }
      await putActivity(ctx, id, {
        activityTypeDTO: {
          typeId: match.typeId,
          typeKey: match.typeKey,
          parentTypeId: match.parentTypeId,
        },
      });
      return {
        success: true,
        activity_id: id,
        type_key: match.typeKey,
        type_id: match.typeId,
        message: "Activity type successfully updated",
      };
    },
  },
  {
    name: "set_activity_description",
    desc: `Set or update the free-text description (notes) of an activity.

This is the notes field shown on the activity page — useful for recording how a session felt, kit used, conditions, niggles, etc. Pass an empty string to clear an existing description.`,
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      description: z.string().describe("New description text (empty string clears it)"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      await putActivity(ctx, id, { description: args.description });
      return {
        success: true,
        activity_id: id,
        description: args.description,
        message: "Activity description successfully updated",
      };
    },
  },
  {
    name: "set_activity_event_type",
    desc: `Set the event type of an activity.

Event type categorises the activity's purpose. Valid keys: race, recreation, specialEvent, training, transportation, touring, geocaching, fitness, uncategorized.`,
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      event_type: z.string().describe("Target event type key (e.g. 'race', 'training')"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const eventType = args.event_type.trim();
      const eventTypes = ((await ctx.api(`${ACTIVITY}/eventTypes`)) ?? []) as Record<string, any>[];
      const match = eventTypes.find((e) => e.typeKey === eventType);
      if (!match) {
        const valid = eventTypes
          .map((e) => e.typeKey)
          .filter(Boolean)
          .join(", ");
        return `Unknown event type '${eventType}'. Valid event types: ${valid}`;
      }
      await putActivity(ctx, id, {
        eventTypeDTO: {
          typeId: match.typeId,
          typeKey: match.typeKey,
          sortOrder: match.sortOrder,
        },
      });
      return {
        success: true,
        activity_id: id,
        event_type: match.typeKey,
        message: "Activity event type successfully updated",
      };
    },
  },
  {
    name: "set_perceived_effort",
    desc: `Set the perceived effort (RPE) for an activity.

Mirrors Garmin Connect's 'Perceived Effort' rating on a 0-10 scale, where 0 clears the rating. Internally Garmin stores this multiplied by 10 (so RPE 7 is stored as 70); this tool handles the conversion.`,
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      rpe: z.number().describe("Perceived effort from 0 to 10 (0 clears the rating)"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      if (args.rpe < 0 || args.rpe > 10) return "rpe must be between 0 and 10";
      await updateSummary(ctx, id, { directWorkoutRpe: Math.round(args.rpe * 10) });
      return {
        success: true,
        activity_id: id,
        rpe: args.rpe,
        message: "Perceived effort successfully updated",
      };
    },
  },
  {
    name: "set_activity_feel",
    desc: `Set how an activity felt ('How did you feel?').

Mirrors Garmin Connect's 5-point feel rating, stored as one of:
  0   = very tired / poor
  25  = tired
  50  = normal
  75  = good
  100 = strong
Higher is better.`,
    params: {
      activity_id: idParam.describe("ID of the activity to update"),
      feel: z.number().int().describe("One of 0, 25, 50, 75, 100"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      if (![0, 25, 50, 75, 100].includes(args.feel)) {
        return "feel must be one of 0, 25, 50, 75, 100";
      }
      await updateSummary(ctx, id, { directWorkoutFeel: args.feel });
      return {
        success: true,
        activity_id: id,
        feel: args.feel,
        message: "Activity feel successfully updated",
      };
    },
  },
  {
    name: "get_activity_splits",
    desc: "Get splits for an activity",
    params: { activity_id: idParam.describe("ID of the activity to retrieve splits for") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const splits = (await ctx.api(`${ACTIVITY}/${id}/splits`)) as Record<string, any> | null;
      if (!splits) return `No splits found for activity with ID ${id}`;
      const laps: Record<string, any>[] = splits.lapDTOs ?? [];
      return {
        activity_id: splits.activityId,
        lap_count: laps.length,
        laps: laps.map((lap) => {
          const lengths: Record<string, any>[] = lap.lengthDTOs ?? [];
          return stripNulls({
            lap_number: lap.lapIndex,
            start_time: lap.startTimeGMT,
            distance_meters: lap.distance,
            duration_seconds: lap.duration,
            moving_duration_seconds: lap.movingDuration,
            elapsed_duration_seconds: lap.elapsedDuration,
            avg_speed_mps: lap.averageSpeed,
            avg_moving_speed_mps: lap.averageMovingSpeed,
            max_speed_mps: lap.maxSpeed,
            avg_hr_bpm: lap.averageHR,
            max_hr_bpm: lap.maxHR,
            calories: lap.calories,
            bmr_calories: lap.bmrCalories,
            avg_cadence: lap.averageRunCadence,
            avg_power_watts: lap.averagePower,
            avg_swim_cadence: lap.averageSwimCadence,
            active_length_count: lap.numberOfActiveLengths,
            total_strokes: lap.totalNumberOfStrokes,
            avg_strokes: lap.averageStrokes,
            avg_swolf: lap.averageSWOLF,
            avg_stroke_distance: lap.averageStrokeDistance,
            intensity_type: lap.intensityType,
            elevation_gain_meters: lap.elevationGain,
            elevation_loss_meters: lap.elevationLoss,
            workout_step_index: lap.wktStepIndex,
            ...(lengths.length
              ? {
                  lengths: lengths.map((len) =>
                    stripNulls({
                      length_number: len.lengthIndex,
                      start_time: len.startTimeGMT,
                      distance_meters: len.distance,
                      duration_seconds: len.duration,
                      avg_speed_mps: len.averageSpeed,
                      max_speed_mps: len.maxSpeed,
                      calories: len.calories,
                      avg_hr_bpm: len.averageHR,
                      max_hr_bpm: len.maxHR,
                      total_strokes: len.totalNumberOfStrokes,
                      avg_swolf: len.averageSWOLF,
                      stroke: len.swimStroke,
                    })
                  ),
                }
              : {}),
          });
        }),
      };
    },
  },
  {
    name: "get_activity_typed_splits",
    desc: "Get typed splits for an activity",
    params: { activity_id: idParam.describe("ID of the activity to retrieve typed splits for") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const typedSplits = await ctx.api(`${ACTIVITY}/${id}/typedsplits`);
      if (!typedSplits) return `No typed splits found for activity with ID ${id}`;
      return typedSplits;
    },
  },
  {
    name: "get_activity_split_summaries",
    desc: "Get split summaries for an activity",
    params: {
      activity_id: idParam.describe("ID of the activity to retrieve split summaries for"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const summaries = await ctx.api(`${ACTIVITY}/${id}/split_summaries`);
      if (!summaries) return `No split summaries found for activity with ID ${id}`;
      return summaries;
    },
  },
  {
    name: "get_activity_weather",
    desc: `Get weather data for an activity.

Garmin's weather endpoint returns temperatures in Fahrenheit (from the weather-station source) with no unit indicator, regardless of account settings. This tool converts them to the account's display unit: metric accounts get Celsius, statute_us accounts keep Fahrenheit. The temperature_unit field ("F" or "C") states which unit was returned.

Wind speed, unlike temperature, is already returned in the account's display unit (km/h for metric, mph for statute_us), so it is passed through unconverted and labeled via the wind_speed_unit field.`,
    params: { activity_id: idParam.describe("ID of the activity to retrieve weather data for") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const weather = (await ctx.api(`${ACTIVITY}/${id}/weather`)) as Record<string, any> | null;
      if (!weather) return `No weather data found for activity with ID ${id}`;

      // Endpoint returns Fahrenheit with no unit field, even for metric accounts
      const fToC = (v: number | null | undefined) =>
        v == null ? undefined : Math.round(((v - 32) * 5) / 9 * 10) / 10;

      const units = await unitSystem(ctx);
      const metric = units !== undefined && units !== "statute_us";
      const tempUnit = metric ? "C" : units === "statute_us" ? "F" : undefined;
      const conv = (v: number | null | undefined) => (metric ? fToC(v) : v ?? undefined);
      // Wind already arrives in the account's display unit; label only
      const windUnit = units === "statute_us" ? "mph" : units !== undefined ? "km/h" : undefined;

      return stripNulls({
        activity_id: id,
        temperature: conv(weather.temp),
        temperature_unit: tempUnit,
        apparent_temperature: conv(weather.apparentTemp),
        dew_point: conv(weather.dewPoint),
        humidity_percent: weather.relativeHumidity,
        wind_speed: weather.windSpeed,
        wind_speed_unit: windUnit,
        wind_direction_degrees: weather.windDirection,
        wind_direction_compass: weather.windDirectionCompassPoint,
        wind_gust: weather.windGust,
        weather_description: weather.weatherTypeDTO?.desc,
        station_id: weather.weatherStationDTO?.id,
        station_name: weather.weatherStationDTO?.name,
        issue_time: weather.issueDate,
      });
    },
  },
  {
    name: "get_activity_hr_in_timezones",
    desc: "Get heart rate data in different time zones for an activity",
    params: {
      activity_id: idParam.describe(
        "ID of the activity to retrieve heart rate time zone data for"
      ),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const hrZones = await ctx.api(`${ACTIVITY}/${id}/hrTimeInZones`);
      if (!hrZones) return `No heart rate time zone data found for activity with ID ${id}`;
      return hrZones;
    },
  },
  {
    name: "get_activity_power_in_timezones",
    desc: `Get power distribution across training zones for an activity.

Returns time spent in each power zone with watt thresholds and duration. Requires a power meter. Zones are based on the athlete's FTP configured in Garmin Connect.`,
    params: {
      activity_id: idParam.describe("ID of the activity to retrieve power zone data for"),
    },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const powerZones = await ctx.api(`${ACTIVITY}/${id}/powerTimeInZones`);
      if (!powerZones) {
        return `No power zone data found for activity ${id}. Ensure the activity was recorded with a power meter.`;
      }
      return powerZones;
    },
  },
  {
    name: "get_activity_gear",
    desc: "Get gear data used for an activity",
    params: { activity_id: idParam.describe("ID of the activity to retrieve gear data for") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const gear = await ctx.api("/gear-service/gear/filterGear", {
        params: { activityId: String(id) },
      });
      if (!gear || (Array.isArray(gear) && gear.length === 0)) {
        return `No gear data found for activity with ID ${id}`;
      }
      return gear;
    },
  },
  {
    name: "get_activity_exercise_sets",
    desc: "Get exercise sets for strength training activities",
    params: { activity_id: idParam.describe("ID of the activity to retrieve exercise sets for") },
    run: async (args, ctx) => {
      const id = actId(args.activity_id);
      const sets = await ctx.api(`${ACTIVITY}/${id}/exerciseSets`);
      if (!sets) return `No exercise sets found for activity with ID ${id}`;
      return sets;
    },
  },
  {
    name: "count_activities",
    desc: `Get total count of activities in the user's Garmin account

Returns the total number of activities recorded.`,
    run: async (_args, ctx) => {
      const data = (await ctx.api("/activitylist-service/activities/count")) as Record<
        string,
        any
      > | null;
      const count = data?.totalCount;
      if (count === undefined || count === null) return "Unable to retrieve activity count";
      return {
        total_activities: count,
        note: "Use get_activities() with pagination to retrieve activity details",
      };
    },
  },
  {
    name: "get_activities",
    desc: `Get activities with pagination support.

Retrieves a paginated list of activities ordered newest-first. Use this for browsing through large activity lists when you do not need to filter by date range, or as a complement to get_activities_by_date.

Each activity includes an event_type field. Common values: "race", "training", "uncategorized" (no event type set by the user — common for Peloton imports and untagged runs). Filter for races with event_type == "race" rather than excluding "training", as many non-race activities appear as "uncategorized" rather than "training".`,
    params: {
      start: z.number().int().default(0).describe("Starting index (default 0)"),
      limit: z
        .number()
        .int()
        .default(20)
        .describe("Maximum number of activities to return (default 20, max 100)"),
    },
    run: async (args, ctx) => {
      const limit = Math.min(Math.max(1, args.limit), 100);
      const activities = ((await ctx.api(ACTIVITIES, {
        params: { start: String(args.start), limit: String(limit) },
      })) ?? []) as Record<string, any>[];
      if (!activities.length) return `No activities found at index ${args.start}`;
      const hasMore = activities.length === limit;
      return {
        start: args.start,
        limit,
        count: activities.length,
        has_more: hasMore,
        next_start: hasMore ? args.start + limit : null,
        activities: activities.map((a) => ({
          ...curateListActivity(a),
          ...stripNulls({
            moving_duration_seconds: a.movingDuration,
            owner_display_name: a.ownerDisplayName,
          }),
        })),
      };
    },
  },
  {
    name: "create_manual_activity",
    desc: `Log a manual activity in Garmin Connect — useful for activities done without a watch.

The type_key must match a Garmin activity type. Use get_activity_types to see the full list. Common values: yoga, strength_training, meditation, indoor_cycling, pilates, bouldering, fitness_equipment.`,
    params: {
      type_key: z.string().describe('Activity type key (e.g. "yoga", "strength_training")'),
      date: dateStr.describe("Date of the activity in YYYY-MM-DD format"),
      duration_minutes: z.number().int().describe("Duration of the activity in minutes"),
      start_time: z
        .string()
        .default("09:00")
        .describe("Start time as HH:MM (24-hour, default 09:00)"),
      activity_name: z
        .string()
        .default("")
        .describe("Optional title; defaults to the type_key if not provided"),
      distance_km: z
        .number()
        .default(0)
        .describe("Distance in kilometres (default 0.0 for non-distance activities)"),
      time_zone: z.string().default("UTC").describe("IANA time zone for the activity (default UTC)"),
    },
    run: async (args, ctx) => {
      const typeKey = args.type_key.trim();
      if (!typeKey) return "Error: type_key is required";
      if (args.duration_minutes <= 0) return "Error: duration_minutes must be greater than 0";

      const name =
        args.activity_name.trim() ||
        typeKey
          .replace(/_/g, " ")
          .split(" ")
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(" ");

      // Same payload shape as python-garminconnect's create_manual_activity
      const result = await ctx.api(ACTIVITY, {
        method: "POST",
        body: {
          activityTypeDTO: { typeKey },
          accessControlRuleDTO: { typeId: 2, typeKey: "private" },
          timeZoneUnitDTO: { unitKey: args.time_zone },
          activityName: name,
          metadataDTO: { autoCalcCalories: true },
          summaryDTO: {
            startTimeLocal: `${args.date}T${args.start_time}:00.000`,
            distance: args.distance_km * 1000,
            duration: args.duration_minutes * 60,
          },
        },
      });
      return { success: true, activity: result };
    },
  },
  {
    name: "get_activity_types",
    desc: `Get all available activity types

Returns a list of all activity types supported by Garmin Connect, useful for filtering activities by type.`,
    run: async (_args, ctx) => {
      const types = ((await ctx.api(`${ACTIVITY}/activityTypes`)) ?? []) as Record<string, any>[];
      if (!types.length) return "No activity types found";
      return {
        count: types.length,
        activity_types: types.map((at) =>
          stripNulls({
            type_id: at.typeId,
            type_key: at.typeKey,
            display_name: at.displayName,
            parent_type_id: at.parentTypeId,
            is_hidden: at.isHidden,
          })
        ),
      };
    },
  },
];
