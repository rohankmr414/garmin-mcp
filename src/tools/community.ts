import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { stripNulls } from "../toolkit";

// Mappings below are estimated from real data and might not be 100% accurate

const BADGE_CATEGORY_MAPPING: Record<number, string> = {
  1: "Activity",
  2: "Running",
  3: "Cycling",
  4: "Challenge",
  5: "Steps",
  9: "Diving",
};

const BADGE_DIFFICULTY_MAPPING: Record<number, string> = {
  1: "Easy",
  2: "Medium",
  3: "Hard",
};

// unitId -> [name, value_type]; value_type formats the progress/target values
const BADGE_UNIT_MAPPING: Record<number, [string, string]> = {
  1: ["distance", "distance"], // meters
  2: ["elevation", "elevation"], // meters
  3: ["activities", "count"],
  5: ["steps", "count"],
  7: ["time", "time"], // seconds
};

const CHALLENGE_CATEGORY_MAPPING: Record<number, string> = {
  1: "Running",
  2: "Cycling",
  3: "Fitness",
  4: "Steps",
  5: "Walking",
  6: "Yoga/Mindfulness",
  9: "Multi-Activity",
};

const CHALLENGE_STATUS_MAPPING: Record<number, string> = {
  1: "Not Started",
  2: "In Progress",
  3: "Completed",
  4: "Ended",
};

const ADHOC_ACTIVITY_TYPE_MAPPING: Record<number, string> = {
  1: "Running",
  2: "Cycling",
  3: "Swimming",
  4: "Steps",
  5: "Walking",
};

// typeId -> [name, value_type]: "time" (s), "distance" (m), "count", "elevation" (m), "days"
const PR_TYPE_MAPPING: Record<number, [string, string]> = {
  1: ["Fastest 1K", "time"],
  2: ["Fastest Mile", "time"],
  3: ["Fastest 5K", "time"],
  4: ["Fastest 10K", "time"],
  5: ["Fastest Half Marathon", "time"],
  6: ["Fastest Marathon", "time"],
  7: ["Longest Run", "distance"],
  8: ["Longest Ride", "distance"],
  9: ["Most Elevation Gain Cycling", "elevation"],
  10: ["Fastest 100K Cycling", "time"],
  11: ["Fastest 40K Cycling", "time"],
  12: ["Most Steps Day", "count"],
  13: ["Most Steps Week", "count"],
  14: ["Most Steps Month", "count"],
  15: ["Longest Daily Goal Streak", "days"],
  16: ["Longest Weekly Goal Streak", "days"],
  17: ["Longest Pool Swim", "distance"],
  18: ["Fastest 100m Pool Swim", "time"],
  19: ["Fastest 400m Pool Swim", "time"],
  20: ["Fastest 500m Pool Swim", "time"],
  21: ["Fastest 800m Pool Swim", "time"],
  22: ["Fastest 1500m Pool Swim", "time"],
  23: ["Fastest 1 Mile Pool Swim", "time"],
};

// Activity type mappings for gear defaults (extrapolated from data)
const GEAR_ACTIVITY_TYPE_MAPPING: Record<number, string> = {
  1: "Running",
  2: "Cycling",
  3: "Swimming",
  4: "Fitness",
  5: "Walking",
  6: "Hiking",
  7: "Strength",
  8: "Other",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatTime(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  const total = Math.trunc(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(secs)}`;
  return `${minutes}:${pad2(secs)}`;
}

function formatDistance(meters: number | null | undefined): string | null {
  if (meters == null) return null;
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters.toFixed(0)} m`;
}

function formatTimestamp(timestampMs: number | null | undefined): string | null {
  if (timestampMs == null) return null;
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function parseIsoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.includes("T") ? iso.split("T")[0] : iso;
}

function firstNonNull(data: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    const value = data[key];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function formatBadgeValue(value: number | null | undefined, unitId: number): string | null {
  if (value == null) return null;
  const unitInfo = BADGE_UNIT_MAPPING[unitId];
  if (!unitInfo) return String(value);
  const valueType = unitInfo[1];
  if (valueType === "time") return formatTime(value);
  if (valueType === "distance") return formatDistance(value);
  if (valueType === "elevation") return `${value.toFixed(0)} m`;
  if (valueType === "count") return Math.trunc(value).toLocaleString("en-US");
  return String(value);
}

function progressPercent(
  progress: number | null | undefined,
  target: number | null | undefined
): string | null {
  if (progress == null || target == null || target === 0) return null;
  const percent = (progress / target) * 100;
  return `${Math.min(percent, 100).toFixed(1)}%`;
}

function curateBadgeChallenge(challenge: Record<string, any>): Record<string, any> {
  const categoryId = challenge.challengeCategoryId;
  const statusId = challenge.badgeChallengeStatusId;
  const unitId = challenge.badgeUnitId;
  const progress = challenge.badgeProgressValue;
  const target = challenge.badgeTargetValue;

  const curated: Record<string, any> = {
    name: challenge.badgeChallengeName ?? null,
    uuid: challenge.uuid ?? null,
    category: CHALLENGE_CATEGORY_MAPPING[categoryId] ?? `category_${categoryId}`,
    status: CHALLENGE_STATUS_MAPPING[statusId] ?? `status_${statusId}`,
    points: challenge.badgePoints ?? null,
    start_date: parseIsoDate(challenge.startDate),
    end_date: parseIsoDate(challenge.endDate),
    joined: challenge.userJoined ?? false,
  };

  if (target != null && target > 0) {
    curated.progress = formatBadgeValue(progress, unitId);
    curated.target = formatBadgeValue(target, unitId);
    curated.progress_percent = progressPercent(progress, target);
  }

  if (challenge.badgeEarnedDate) curated.earned_date = parseIsoDate(challenge.badgeEarnedDate);
  return curated;
}

function formatPrValue(value: number | null | undefined, valueType: string): string | null {
  if (value == null) return null;
  if (valueType === "time") return formatTime(value);
  if (valueType === "distance") return formatDistance(value);
  if (valueType === "elevation") return `${value.toFixed(0)} m`;
  if (valueType === "count") return Math.trunc(value).toLocaleString("en-US");
  if (valueType === "days") return `${Math.trunc(value)} days`;
  return String(value);
}

function formatAlarmTime(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

const challengeListParams = {
  start: z.number().int().default(1).describe("Starting index for pagination (starts at 1)"),
  limit: z
    .number()
    .int()
    .default(20)
    .describe("Maximum number of challenges to return (default 20, max 100)"),
};

async function fetchChallenges(
  ctx: Ctx,
  path: string,
  start: number,
  limit: number
): Promise<Record<string, any>[]> {
  const res = await ctx.api(path, {
    params: { start: String(start), limit: String(Math.min(limit, 100)) },
  });
  return (res as Record<string, any>[]) ?? [];
}

const descByStartDate = (a: Record<string, any>, b: Record<string, any>) =>
  (b.start_date ?? "") < (a.start_date ?? "") ? -1 : (b.start_date ?? "") > (a.start_date ?? "") ? 1 : 0;

export const tools: ToolDef[] = [
  {
    name: "get_goals",
    desc: 'Get Garmin Connect goals (active, future, or past)',
    params: {
      goal_type: z
        .enum(["active", "future", "past"])
        .default("active")
        .describe('Type of goals to retrieve. Options: "active", "future", or "past"'),
    },
    run: async (args, ctx) => {
      const goals: unknown[] = [];
      const limit = 30;
      // Workers loop cap: at most 39 pages instead of the client's 2000
      for (let start = 0, page = 0; page < 39; page++, start += limit) {
        const batch = (await ctx.api("/goal-service/goal/goals", {
          params: {
            status: args.goal_type,
            start: String(start),
            limit: String(limit),
            sortOrder: "asc",
          },
        })) as unknown[];
        if (!batch || batch.length === 0) break;
        goals.push(...batch);
      }
      if (goals.length === 0) return `No ${args.goal_type} goals found.`;
      return goals;
    },
  },
  {
    name: "get_personal_record",
    desc: "Get personal records for user",
    run: async (_args, ctx) => {
      const records = (await ctx.api(
        `/personalrecord-service/personalrecord/prs/${await ctx.displayName()}`
      )) as Record<string, any>[];
      if (!records || records.length === 0) return "No personal records found.";

      const curated = records.map((record) => {
        const typeId = record.typeId;
        const prInfo = PR_TYPE_MAPPING[typeId];
        const [prName, valueType] = prInfo ?? [`Unknown Record (typeId=${typeId})`, "unknown"];
        const rawValue = record.value ?? null;
        const out: Record<string, any> = {
          record_type: prName,
          type_id: typeId,
          value: formatPrValue(rawValue, valueType),
          raw_value: rawValue,
          date: formatTimestamp(record.prStartTimeGMT),
        };
        if (record.activityId) out.activity_id = record.activityId;
        return out;
      });

      curated.sort((a, b) => (a.type_id ?? 0) - (b.type_id ?? 0));
      return curated;
    },
  },
  {
    name: "get_earned_badges",
    desc: "Get earned badges for user",
    run: async (_args, ctx) => {
      const badges = (await ctx.api("/badge-service/badge/earned")) as Record<string, any>[];
      if (!badges || badges.length === 0) return "No earned badges found.";

      const curated = badges.map((badge) => {
        const categoryId = badge.badgeCategoryId;
        const difficultyId = badge.badgeDifficultyId;
        const unitId = badge.badgeUnitId;
        const progress = badge.badgeProgressValue;
        const target = badge.badgeTargetValue;

        const out: Record<string, any> = {
          name: badge.badgeName ?? null,
          category: BADGE_CATEGORY_MAPPING[categoryId] ?? `category_${categoryId}`,
          difficulty: BADGE_DIFFICULTY_MAPPING[difficultyId] ?? `level_${difficultyId}`,
          points: badge.badgePoints ?? null,
          earned_date: parseIsoDate(badge.badgeEarnedDate),
        };
        if (target != null && progress != null) {
          out.progress = formatBadgeValue(progress, unitId);
          out.target = formatBadgeValue(target, unitId);
        }
        const startDate = parseIsoDate(badge.badgeStartDate);
        const endDate = parseIsoDate(badge.badgeEndDate);
        if (startDate && endDate) out.challenge_period = `${startDate} to ${endDate}`;
        if (badge.badgeAssocType === "activityId" && badge.badgeAssocDataId) {
          out.activity_id = badge.badgeAssocDataId;
        }
        if (badge.badgeSeriesId) out.series_id = badge.badgeSeriesId;
        return out;
      });

      curated.sort((a, b) =>
        (b.earned_date ?? "") < (a.earned_date ?? "") ? -1 : (b.earned_date ?? "") > (a.earned_date ?? "") ? 1 : 0
      );
      return { total_badges: curated.length, badges: curated };
    },
  },
  {
    name: "get_adhoc_challenges",
    desc:
      "Get user-created social/group challenges (e.g., step competitions with friends). " +
      "Returns challenges created by users to compete with connections. These are " +
      "different from official Garmin badge challenges.",
    params: {
      start: z.number().int().default(0).describe("Starting index for pagination (default 0)"),
      limit: z
        .number()
        .int()
        .default(20)
        .describe("Maximum number of challenges to return (default 20, max 100)"),
    },
    run: async (args, ctx) => {
      const challenges = await fetchChallenges(
        ctx,
        "/adhocchallenge-service/adHocChallenge/historical",
        args.start,
        args.limit
      );
      if (challenges.length === 0) return "No adhoc challenges found.";

      const curated = challenges.map((challenge) => {
        const statusId = challenge.socialChallengeStatusId;
        const activityTypeId = challenge.socialChallengeActivityTypeId;
        return {
          name: challenge.adHocChallengeName ?? null,
          description: challenge.adHocChallengeDesc ?? null,
          uuid: challenge.uuid ?? null,
          activity_type: ADHOC_ACTIVITY_TYPE_MAPPING[activityTypeId] ?? `type_${activityTypeId}`,
          status: CHALLENGE_STATUS_MAPPING[statusId] ?? `status_${statusId}`,
          start_date: parseIsoDate(challenge.startDate),
          end_date: parseIsoDate(challenge.endDate),
          your_ranking: challenge.userRanking ?? null,
          player_count: challenge.playerCount ?? null,
        };
      });

      curated.sort(descByStartDate);
      return { total: curated.length, challenges: curated };
    },
  },
  {
    name: "get_available_badge_challenges",
    desc:
      "Get official Garmin badge challenges available to join. " +
      "Returns monthly/seasonal challenges from Garmin that the user can join. " +
      "These challenges award badges and points upon completion.",
    params: challengeListParams,
    run: async (args, ctx) => {
      const challenges = await fetchChallenges(
        ctx,
        "/badgechallenge-service/badgeChallenge/available",
        args.start,
        args.limit
      );
      if (challenges.length === 0) return "No available badge challenges found.";

      const curated = challenges.map((challenge): Record<string, any> => ({
        ...curateBadgeChallenge(challenge),
        joinable: challenge.joinable ?? true,
      }));

      curated.sort((a, b) => ((a.start_date ?? "") < (b.start_date ?? "") ? -1 : (a.start_date ?? "") > (b.start_date ?? "") ? 1 : 0));
      return { total: curated.length, challenges: curated };
    },
  },
  {
    name: "get_badge_challenges",
    desc:
      "Get all badge challenges the user has joined (completed and in-progress). " +
      "Returns the user's history of badge challenges including progress, " +
      "completion status, and earned dates.",
    params: challengeListParams,
    run: async (args, ctx) => {
      const challenges = await fetchChallenges(
        ctx,
        "/badgechallenge-service/badgeChallenge/completed",
        args.start,
        args.limit
      );
      if (challenges.length === 0) return "No badge challenges found.";

      const curated = challenges.map(curateBadgeChallenge);
      curated.sort(descByStartDate);
      return { total: curated.length, challenges: curated };
    },
  },
  {
    name: "get_non_completed_badge_challenges",
    desc:
      "Get badge challenges currently in progress (not yet completed). " +
      "Returns active challenges the user has joined but hasn't completed yet. " +
      "Useful for tracking current progress toward badge goals.",
    params: challengeListParams,
    run: async (args, ctx) => {
      const challenges = await fetchChallenges(
        ctx,
        "/badgechallenge-service/badgeChallenge/non-completed",
        args.start,
        args.limit
      );
      if (challenges.length === 0) return "No in-progress badge challenges found.";

      const curated = challenges.map(curateBadgeChallenge);
      curated.sort((a, b) => ((a.end_date ?? "") < (b.end_date ?? "") ? -1 : (a.end_date ?? "") > (b.end_date ?? "") ? 1 : 0));
      return { total: curated.length, challenges: curated };
    },
  },
  {
    name: "get_race_predictions",
    desc:
      "Get predicted race times based on current fitness level. " +
      "Returns Garmin's predictions for 5K, 10K, half marathon, and marathon " +
      "finish times based on the user's recent training data and VO2 max.",
    run: async (_args, ctx) => {
      const p = (await ctx.api(
        `/metrics-service/metrics/racepredictions/latest/${await ctx.displayName()}`
      )) as Record<string, any>;
      if (!p) return "No race predictions found.";

      return {
        prediction_date: p.calendarDate ?? null,
        predictions: {
          "5K": { time: formatTime(p.time5K), time_seconds: p.time5K ?? null },
          "10K": { time: formatTime(p.time10K), time_seconds: p.time10K ?? null },
          half_marathon: {
            time: formatTime(p.timeHalfMarathon),
            time_seconds: p.timeHalfMarathon ?? null,
          },
          marathon: { time: formatTime(p.timeMarathon), time_seconds: p.timeMarathon ?? null },
        },
      };
    },
  },
  {
    name: "get_inprogress_virtual_challenges",
    desc:
      "Get in-progress virtual challenges/expeditions. " +
      "Returns virtual challenges (like walking expeditions on famous trails) " +
      "that the user is currently participating in.",
    params: {
      start: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("Starting index for pagination (default 1, must be >= 1)"),
      limit: z
        .number()
        .int()
        .default(20)
        .describe("Maximum number of challenges to return (default 20, max 100)"),
    },
    run: async (args, ctx) => {
      const challenges = (await ctx.api(
        "/badgechallenge-service/virtualChallenge/inProgress",
        { params: { start: String(args.start), limit: String(Math.min(args.limit, 100)) } }
      )) as unknown;
      if (!challenges || (Array.isArray(challenges) && challenges.length === 0)) {
        return "No in-progress virtual challenges found.";
      }

      // API shape varies: bare list, or dict possibly wrapping a "challenges" list
      let challengeList: Record<string, any>[];
      if (Array.isArray(challenges)) challengeList = challenges as Record<string, any>[];
      else if (challenges && typeof challenges === "object") {
        const c = challenges as Record<string, any>;
        challengeList = c.challenges !== undefined ? c.challenges : [c];
      } else challengeList = [];

      const curated = challengeList.map((challenge) => {
        const out: Record<string, any> = {
          name: challenge.badgeChallengeName || challenge.name || challenge.challengeName || null,
          uuid: challenge.uuid ?? null,
          start_date: parseIsoDate(challenge.startDate),
          end_date: parseIsoDate(challenge.endDate),
        };

        const progress = firstNonNull(challenge, "badgeProgressValue", "progress", "progressValue");
        const target = firstNonNull(challenge, "badgeTargetValue", "target", "targetValue");
        if (progress !== null && target !== null && target > 0) {
          const unitId = challenge.badgeUnitId;
          if (unitId == null || unitId === 1) {
            // legacy meters/km contract for distance or payloads without unit metadata
            out.progress_meters = progress;
            out.target_meters = target;
            out.progress_km = `${(progress / 1000).toFixed(2)} km`;
            out.target_km = `${(target / 1000).toFixed(2)} km`;
          } else {
            out.progress = formatBadgeValue(progress, unitId);
            out.target = formatBadgeValue(target, unitId);
          }
          out.progress_percent = progressPercent(progress, target);
        }
        return out;
      });

      return { total: curated.length, challenges: curated };
    },
  },
  {
    name: "get_devices",
    desc: "Get all Garmin devices associated with the user account",
    run: async (_args, ctx) => {
      const devices = (await ctx.api("/device-service/deviceregistration/devices")) as Record<
        string,
        any
      >[];
      if (!devices || devices.length === 0) return "No devices found.";

      // Drop the 200+ capability flags, keep only essential info
      return devices.map((device) => {
        const info: Record<string, any> = {
          device_id: device.deviceId,
          device_name: device.displayName || device.productDisplayName,
          model: device.partNumber,
          manufacturer: device.manufacturerName,
          serial_number: device.serialNumber,
          software_version: device.softwareVersionString,
          status: device.deviceStatusName,
          last_sync_time: device.lastSyncTime,
          battery_status: device.batteryStatus,
        };
        if (device.deviceType) info.device_type = device.deviceType;
        if (device.primaryDevice != null) info.is_primary = device.primaryDevice;
        return stripNulls(info);
      });
    },
  },
  {
    name: "get_device_last_used",
    desc: "Get information about the last used Garmin device",
    run: async (_args, ctx) => {
      const device = (await ctx.api("/device-service/deviceservice/mylastused")) as Record<
        string,
        any
      >;
      if (!device) return "No last used device found.";

      const curated: Record<string, any> = {
        user_device_id: device.userDeviceId,
        device_name: device.lastUsedDeviceName,
        device_key: device.lastUsedDeviceApplicationKey,
        user_profile_id: device.userProfileNumber,
      };
      const uploadMs = device.lastUsedDeviceUploadTime;
      if (uploadMs) {
        // UTC; Workers has no local timezone
        curated.last_upload_time = new Date(uploadMs).toISOString().slice(0, 19).replace("T", " ");
      }
      if (device.imageUrl) curated.image_url = device.imageUrl;
      return stripNulls(curated);
    },
  },
  {
    name: "get_device_settings",
    desc:
      "Get settings for a specific Garmin device. " +
      "Returns device configuration including time/date format, units, " +
      "activity tracking settings, and alarm information.",
    params: {
      device_id: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          "Device ID (optional; defaults to the most recently used device when omitted; " +
            "can be obtained from get_devices or get_device_last_used)"
        ),
    },
    run: async (args, ctx) => {
      let deviceId = args.device_id;
      if (deviceId == null) {
        const lastUsed = (await ctx.api("/device-service/deviceservice/mylastused")) as Record<
          string,
          any
        >;
        if (!lastUsed) {
          return "No default device found. Pass device_id explicitly or register a device with Garmin Connect.";
        }
        deviceId = lastUsed.userDeviceId;
        if (!deviceId) return "Default device has no userDeviceId. Pass device_id explicitly.";
      }

      const settings = (await ctx.api(
        `/device-service/deviceservice/device-info/settings/${deviceId}`
      )) as Record<string, any>;
      if (!settings) return `No settings found for device ID ${deviceId}.`;

      const curated: Record<string, any> = {
        device_id: settings.deviceId,
        time_format: settings.timeFormat,
        date_format: settings.dateFormat,
        measurement_units: settings.measurementUnits,
      };
      if (settings.keyTonesEnabled != null) curated.key_tones_enabled = settings.keyTonesEnabled;
      if (settings.keyVibrationEnabled != null)
        curated.key_vibration_enabled = settings.keyVibrationEnabled;
      if (settings.alertTonesEnabled != null)
        curated.alert_tones_enabled = settings.alertTonesEnabled;

      const at = settings.activityTracking ?? {};
      const tracking: Record<string, any> = {};
      if (at.moveAlertEnabled != null) tracking.move_alert_enabled = at.moveAlertEnabled;
      if (at.pulseOxSleepTrackingEnabled != null)
        tracking.pulse_ox_sleep_tracking = at.pulseOxSleepTrackingEnabled;
      if (at.highHrAlertEnabled != null) tracking.high_hr_alert_enabled = at.highHrAlertEnabled;
      if (at.lowHrAlertEnabled != null) tracking.low_hr_alert_enabled = at.lowHrAlertEnabled;
      if (Object.keys(tracking).length > 0) curated.activity_tracking = tracking;

      const alarms = (settings.alarms ?? []) as Record<string, any>[];
      if (alarms.length > 0) {
        curated.alarm_count = alarms.length;
        curated.enabled_alarm_count = alarms.filter((a) => a.alarmMode === "ON").length;
      }
      return stripNulls(curated);
    },
  },
  {
    name: "get_primary_training_device",
    desc:
      "Get information about the primary training device. " +
      "Returns details about the device designated as primary for training " +
      "metrics, along with other wearable devices on the account.",
    run: async (_args, ctx) => {
      const data = (await ctx.api("/web-gateway/device-info/primary-training-device")) as Record<
        string,
        any
      >;
      if (!data) return "No primary training device found.";

      const curated: Record<string, any> = {
        primary_device_id: (data.PrimaryTrainingDevice ?? {}).deviceId ?? null,
      };

      const primaryDevices = ((data.PrimaryTrainingDevices ?? {}).deviceWeights ??
        []) as Record<string, any>[];
      if (primaryDevices.length > 0) {
        curated.training_devices = primaryDevices.map((device) => {
          const info: Record<string, any> = {
            device_id: device.deviceId ?? null,
            display_name: device.displayName ?? null,
            is_primary_wearable: device.primaryWearableDevice ?? null,
            primary_training_capable: device.primaryTrainingCapable ?? null,
          };
          if (device.imageUrl) info.image_url = device.imageUrl;
          return info;
        });
        curated.training_device_count = primaryDevices.length;
      }

      const wearable = data.WearableDevices ?? {};
      if (wearable.wearableDeviceCount) curated.wearable_device_count = wearable.wearableDeviceCount;
      return curated;
    },
  },
  {
    name: "get_device_solar_data",
    desc:
      "Get solar data for a specific device. " +
      "Returns solar charging data for devices with solar panels (e.g., Instinct Solar, " +
      "Fenix Solar). Only applicable to solar-capable devices.",
    params: {
      device_id: z.string().describe("Device ID (can be obtained from get_devices)"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const resp = (await ctx.api(
        `/web-gateway/solar/${args.device_id}/${args.date}/${args.date}`,
        { params: { singleDayView: "true" } }
      )) as Record<string, any>;
      const solarData = resp?.deviceSolarInput;
      if (!solarData) return `No solar data found for device ID ${args.device_id} on ${args.date}.`;

      const dailyData = (solarData.solarDailyDataDTOs ?? []) as Record<string, any>[];
      if (dailyData.length === 0) {
        return `No solar data available for device ID ${args.device_id} on ${args.date}. This device may not have solar capabilities.`;
      }

      const curatedDays = dailyData.map((day) =>
        stripNulls({
          date: day.calendarDate,
          solar_intensity_avg: day.solarIntensityAvg,
          solar_intensity_max: day.solarIntensityMax,
          battery_charged_percent: day.batteryCharged,
          battery_used_percent: day.batteryUsed,
          battery_net_percent: day.batteryNet,
        })
      );
      return { device_id: args.device_id, solar_data: curatedDays };
    },
  },
  {
    name: "get_device_alarms",
    desc:
      "Get alarms from all Garmin devices. " +
      "Returns all configured alarms with their schedules, sounds, and enabled status.",
    run: async (_args, ctx) => {
      const devices = ((await ctx.api("/device-service/deviceregistration/devices")) ??
        []) as Record<string, any>[];
      const alarms: Record<string, any>[] = [];
      // Workers loop cap: one settings call per device, at most 10 devices
      for (const device of devices.slice(0, 10)) {
        const settings = (await ctx.api(
          `/device-service/deviceservice/device-info/settings/${device.deviceId}`
        )) as Record<string, any>;
        if (settings?.alarms) alarms.push(...settings.alarms);
      }
      if (alarms.length === 0) return "No device alarms found.";

      const curated = alarms.map((alarm) => {
        const timeMinutes = alarm.alarmTime ?? null;
        const info: Record<string, any> = {
          alarm_id: alarm.alarmId ?? null,
          time: formatAlarmTime(timeMinutes),
          time_minutes: timeMinutes,
          enabled: alarm.alarmMode === "ON",
          days: alarm.alarmDays ?? [],
          sound: alarm.alarmSound ?? null,
        };
        if (alarm.backlight) info.backlight = alarm.backlight;
        if (alarm.alarmMessage) info.message = alarm.alarmMessage;
        return info;
      });

      curated.sort((a, b) => (a.time_minutes ?? 0) - (b.time_minutes ?? 0));
      return {
        total_alarms: curated.length,
        enabled_alarms: curated.filter((a) => a.enabled).length,
        alarms: curated,
      };
    },
  },
  {
    name: "get_gear",
    desc:
      "Get all gear registered with the user account. " +
      "Returns complete gear inventory including usage statistics and default " +
      "activity associations. No parameters required - user profile is fetched automatically.",
    params: {
      include_stats: z
        .boolean()
        .default(true)
        .describe(
          "Include usage statistics for each gear item (default True). " +
            "Set to False for faster response with large gear collections."
        ),
    },
    run: async (args, ctx) => {
      const deviceInfo = (await ctx.api("/device-service/deviceservice/mylastused")) as Record<
        string,
        any
      >;
      if (!deviceInfo) {
        return "Could not retrieve user profile. Please ensure you have a synced device.";
      }
      const userProfileId = deviceInfo.userProfileNumber;

      const gearList = (await ctx.api("/gear-service/gear/filterGear", {
        params: { userProfilePk: String(userProfileId) },
      })) as Record<string, any>[];
      if (!gearList || gearList.length === 0) return "No gear found.";

      const defaultsList = (((await ctx.api(
        `/gear-service/gear/user/${userProfileId}/activityTypes`
      )) as Record<string, any>[]) ?? []);
      const defaultsByUuid: Record<string, string[]> = {};
      for (const d of defaultsList) {
        const activityType =
          GEAR_ACTIVITY_TYPE_MAPPING[d.activityTypePk] ?? `activity_${d.activityTypePk}`;
        (defaultsByUuid[d.uuid] ??= []).push(activityType);
      }

      const curatedGear: Record<string, any>[] = [];
      let activeCount = 0;
      let retiredCount = 0;

      for (const [i, g] of gearList.entries()) {
        const uuid = g.uuid;
        const status = (g.gearStatusName ?? "").toLowerCase();
        if (status === "active") activeCount++;
        else if (status === "retired") retiredCount++;

        const item: Record<string, any> = {
          uuid,
          name: g.displayName ?? null,
          full_name: g.customMakeModel ?? null,
          type: g.gearTypeName ?? null,
          status,
          date_begin: parseIsoDate(g.dateBegin),
          date_end: parseIsoDate(g.dateEnd),
        };

        const maxMeters = g.maximumMeters;
        if (maxMeters && maxMeters > 0) item.max_distance_km = Math.round(maxMeters / 100) / 10;
        if (defaultsByUuid[uuid]) item.is_default_for = defaultsByUuid[uuid];

        // Workers loop cap: fetch stats for at most 30 gear items
        if (args.include_stats && i < 30) {
          try {
            const stats = (await ctx.api(`/gear-service/gear/stats/${uuid}`)) as Record<
              string,
              any
            >;
            if (stats) {
              item.stats = {
                total_activities: stats.totalActivities ?? null,
                total_distance_km: Math.round((stats.totalDistance ?? 0) / 100) / 10,
              };
            }
          } catch {
            // stats unavailable for this gear
          }
        }

        curatedGear.push(item);
      }

      // active first, then date_begin descending within each group
      curatedGear.sort((a, b) => {
        const g = Number(a.status !== "active") - Number(b.status !== "active");
        if (g !== 0) return g;
        return (b.date_begin ?? "") < (a.date_begin ?? "") ? -1 : (b.date_begin ?? "") > (a.date_begin ?? "") ? 1 : 0;
      });

      const defaultsSummary: Record<string, string | null> = {};
      for (const [uuid, activities] of Object.entries(defaultsByUuid)) {
        const gearName = curatedGear.find((g) => g.uuid === uuid)?.name ?? null;
        for (const activity of activities) defaultsSummary[activity] = gearName;
      }

      return {
        gear_count: curatedGear.length,
        active_count: activeCount,
        retired_count: retiredCount,
        defaults: defaultsSummary,
        gear: curatedGear,
      };
    },
  },
  {
    name: "add_gear_to_activity",
    desc:
      "Associate gear with an activity. " +
      "Links a specific piece of gear (like shoes, bike, etc.) to an activity.",
    params: {
      activity_id: z.number().int().describe("ID of the activity"),
      gear_uuid: z.string().describe("UUID of the gear to add (get from get_gear)"),
    },
    run: async (args, ctx) => {
      await ctx.api(`/gear-service/gear/link/${args.gear_uuid}/activity/${args.activity_id}`, {
        method: "PUT",
      });
      return {
        success: true,
        activity_id: args.activity_id,
        gear_uuid: args.gear_uuid,
        message: "Gear successfully added to activity",
      };
    },
  },
  {
    name: "remove_gear_from_activity",
    desc:
      "Remove gear association from an activity. " +
      "Unlinks a specific piece of gear from an activity.",
    params: {
      activity_id: z.number().int().describe("ID of the activity"),
      gear_uuid: z.string().describe("UUID of the gear to remove"),
    },
    run: async (args, ctx) => {
      await ctx.api(`/gear-service/gear/unlink/${args.gear_uuid}/activity/${args.activity_id}`, {
        method: "PUT",
      });
      return {
        success: true,
        activity_id: args.activity_id,
        gear_uuid: args.gear_uuid,
        message: "Gear successfully removed from activity",
      };
    },
  },
];
