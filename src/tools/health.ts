import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { addDays, assertSpan, dateStr, isoDate, parseDate, stripNulls } from "../toolkit";

const weeksParam = z
  .number()
  .int()
  .min(1)
  .default(4)
  .describe("Number of weeks to fetch (default 4, max 52)");

const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;

// mirrors Python's `if not data` falsy check
const isEmpty = (v: unknown) =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && Object.keys(v as object).length === 0);

const userSummary = async (ctx: Ctx, date: string) => {
  const s = (await ctx.api(
    `/usersummary-service/usersummary/daily/${await ctx.displayName()}`,
    { params: { calendarDate: date } }
  )) as Record<string, any>;
  if (s?.privacyProtected === true) throw new Error("Authentication error: profile is privacy protected");
  return s;
};

const sleepData = async (ctx: Ctx, date: string) =>
  (await ctx.api(`/wellness-service/wellness/dailySleepData/${await ctx.displayName()}`, {
    params: { date, nonSleepBufferMinutes: "60" },
  })) as Record<string, any>;

const stressData = (ctx: Ctx, date: string) =>
  ctx.api(`/wellness-service/wellness/dailyStress/${date}`) as Promise<Record<string, any>>;

const respirationData = (ctx: Ctx, date: string) =>
  ctx.api(`/wellness-service/wellness/daily/respiration/${date}`) as Promise<Record<string, any>>;

const heartRates = async (ctx: Ctx, date: string) =>
  (await ctx.api(`/wellness-service/wellness/dailyHeartRate/${await ctx.displayName()}`, {
    params: { date },
  })) as Record<string, any>;

const trainingReadiness = (ctx: Ctx, date: string) =>
  ctx.api(`/metrics-service/metrics/trainingreadiness/${date}`) as Promise<Record<string, any>[]>;

const bodyComposition = (ctx: Ctx, startDate: string, endDate: string) =>
  ctx.api("/weight-service/weight/dateRange", {
    params: { startDate, endDate },
  }) as Promise<Record<string, any>>;

const sortByWeekDesc = (weeksList: Record<string, any>[]) =>
  weeksList.sort((a, b) => String(b.week_start ?? "").localeCompare(String(a.week_start ?? "")));

export const tools: ToolDef[] = [
  {
    name: "get_stats",
    desc: "Get daily activity stats with curated essential metrics. Returns a summary of daily health and activity data including steps, calories, heart rate, stress, body battery, and sleep metrics.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const stats = await userSummary(ctx, args.date);
      if (isEmpty(stats)) return `No stats found for ${args.date}`;
      return stripNulls({
        date: stats.calendarDate,
        total_steps: stats.totalSteps,
        daily_step_goal: stats.dailyStepGoal,
        distance_meters: stats.totalDistanceMeters,
        floors_ascended: stats.floorsAscended ? round(stats.floorsAscended, 1) : null,
        floors_descended: stats.floorsDescended ? round(stats.floorsDescended, 1) : null,
        total_calories: stats.totalKilocalories,
        active_calories: stats.activeKilocalories,
        bmr_calories: stats.bmrKilocalories,
        highly_active_seconds: stats.highlyActiveSeconds,
        active_seconds: stats.activeSeconds,
        sedentary_seconds: stats.sedentarySeconds,
        sleeping_seconds: stats.sleepingSeconds,
        moderate_intensity_minutes: stats.moderateIntensityMinutes,
        vigorous_intensity_minutes: stats.vigorousIntensityMinutes,
        intensity_minutes_goal: stats.intensityMinutesGoal,
        min_heart_rate_bpm: stats.minHeartRate,
        max_heart_rate_bpm: stats.maxHeartRate,
        resting_heart_rate_bpm: stats.restingHeartRate,
        last_7_days_avg_resting_hr: stats.lastSevenDaysAvgRestingHeartRate,
        avg_stress_level: stats.averageStressLevel,
        max_stress_level: stats.maxStressLevel,
        stress_qualifier: stats.stressQualifier,
        body_battery_charged: stats.bodyBatteryChargedValue,
        body_battery_drained: stats.bodyBatteryDrainedValue,
        body_battery_highest: stats.bodyBatteryHighestValue,
        body_battery_lowest: stats.bodyBatteryLowestValue,
        body_battery_current: stats.bodyBatteryMostRecentValue,
        avg_spo2_percent: stats.averageSpo2,
        lowest_spo2_percent: stats.lowestSpo2,
        avg_waking_respiration: stats.avgWakingRespirationValue,
        highest_respiration: stats.highestRespirationValue,
        lowest_respiration: stats.lowestRespirationValue,
      });
    },
  },
  {
    name: "get_user_summary",
    desc: "Get user summary data (compatible with garminconnect-ha)",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const summary = await userSummary(ctx, args.date);
      if (isEmpty(summary)) return `No user summary found for ${args.date}`;
      return summary;
    },
  },
  {
    name: "get_body_composition",
    desc: "Get body composition data for a single date or date range",
    params: {
      start_date: dateStr.describe("Date in YYYY-MM-DD format or start date if end_date provided"),
      end_date: dateStr.optional().describe("Optional end date in YYYY-MM-DD format for date range"),
    },
    run: async (args, ctx) => {
      const composition = await bodyComposition(ctx, args.start_date, args.end_date ?? args.start_date);
      if (isEmpty(composition)) {
        return args.end_date
          ? `No body composition data found between ${args.start_date} and ${args.end_date}`
          : `No body composition data found for ${args.start_date}`;
      }
      return composition;
    },
  },
  {
    name: "get_stats_and_body",
    desc: "Get stats and body composition data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const stats = await userSummary(ctx, args.date);
      const body = await bodyComposition(ctx, args.date, args.date);
      const bodyAvg = body?.totalAverage && typeof body.totalAverage === "object" ? body.totalAverage : {};
      const merged = { ...stats, ...bodyAvg };
      if (isEmpty(merged)) return `No stats and body composition data found for ${args.date}`;
      return merged;
    },
  },
  {
    name: "get_steps_data",
    desc: "Get detailed steps data with 15-minute intervals. Note: This returns full interval data (~14KB). For a compact summary, use get_stats() which includes total_steps.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const steps = await ctx.api(
        `/wellness-service/wellness/dailySummaryChart/${await ctx.displayName()}`,
        { params: { date: args.date } }
      );
      if (isEmpty(steps)) return `No steps data found for ${args.date}`;
      return steps;
    },
  },
  {
    name: "get_daily_steps",
    desc: "Get steps data for a date range",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      // API caps at 28 days per request; 1120 days = 40 chunks, the worker call budget
      assertSpan(args.start_date, args.end_date, 1120);
      const end = parseDate(args.end_date);
      const all: unknown[] = [];
      for (let cur = parseDate(args.start_date); cur <= end; ) {
        const chunkEnd = addDays(cur, 27) < end ? addDays(cur, 27) : end;
        const chunk = await ctx.api(
          `/usersummary-service/stats/steps/daily/${isoDate(cur)}/${isoDate(chunkEnd)}`
        );
        if (Array.isArray(chunk)) all.push(...chunk);
        cur = addDays(chunkEnd, 1);
      }
      if (all.length === 0)
        return `No daily steps data found between ${args.start_date} and ${args.end_date}`;
      return all;
    },
  },
  {
    name: "get_training_readiness",
    desc: "Get training readiness data with curated metrics. Returns training readiness score and contributing factors.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const list = await trainingReadiness(ctx, args.date);
      if (isEmpty(list)) return `No training readiness data found for ${args.date}`;
      return list.map((r) =>
        stripNulls({
          date: r.calendarDate,
          timestamp: r.timestampLocal,
          context: r.inputContext,
          level: r.level,
          score: r.score,
          feedback: r.feedbackShort,
          sleep_score: r.sleepScore,
          sleep_factor_percent: r.sleepScoreFactorPercent,
          sleep_factor_feedback: r.sleepScoreFactorFeedback,
          recovery_time_hours: r.recoveryTime ? round(r.recoveryTime / 60, 1) : null,
          recovery_factor_percent: r.recoveryTimeFactorPercent,
          recovery_factor_feedback: r.recoveryTimeFactorFeedback,
          training_load_factor_percent: r.acwrFactorPercent,
          training_load_feedback: r.acwrFactorFeedback,
          acute_load: r.acuteLoad,
          hrv_factor_percent: r.hrvFactorPercent,
          hrv_factor_feedback: r.hrvFactorFeedback,
          hrv_weekly_avg: r.hrvWeeklyAverage,
          stress_history_factor_percent: r.stressHistoryFactorPercent,
          stress_history_feedback: r.stressHistoryFactorFeedback,
          sleep_history_factor_percent: r.sleepHistoryFactorPercent,
          sleep_history_feedback: r.sleepHistoryFactorFeedback,
        })
      );
    },
  },
  {
    name: "get_body_battery",
    desc: "Get body battery data with events",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const days = (await ctx.api("/wellness-service/wellness/bodyBattery/reports/daily", {
        params: { startDate: args.start_date, endDate: args.end_date },
      })) as Record<string, any>[];
      if (isEmpty(days))
        return `No body battery data found between ${args.start_date} and ${args.end_date}`;
      return days.map((day) => {
        const entry: Record<string, any> = {
          date: day.date,
          charged: day.charged,
          drained: day.drained,
          events: (day.bodyBatteryActivityEvent ?? []).map((event: Record<string, any>) => ({
            type: event.eventType,
            start_time: event.eventStartTimeGmt,
            duration_minutes: round((event.durationInMilliseconds ?? 0) / 60000, 1),
            body_battery_impact: event.bodyBatteryImpact,
            feedback: event.shortFeedback,
          })),
        };
        const feedback = day.bodyBatteryDynamicFeedbackEvent;
        if (!isEmpty(feedback)) {
          entry.current_feedback = feedback.feedbackShortType;
          entry.body_battery_level = feedback.bodyBatteryLevel;
        }
        return entry;
      });
    },
  },
  {
    name: "get_body_battery_events",
    desc: "Get body battery events data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const events = await ctx.api(`/wellness-service/wellness/bodyBattery/events/${args.date}`);
      if (isEmpty(events)) return `No body battery events found for ${args.date}`;
      return events;
    },
  },
  {
    name: "get_blood_pressure",
    desc: "Get blood pressure data",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const bp = await ctx.api(
        `/bloodpressure-service/bloodpressure/range/${args.start_date}/${args.end_date}`,
        { params: { includeAll: "true" } }
      );
      if (isEmpty(bp))
        return `No blood pressure data found between ${args.start_date} and ${args.end_date}`;
      return bp;
    },
  },
  {
    name: "get_floors",
    desc: "Get floors climbed data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const floors = await ctx.api(`/wellness-service/wellness/floorsChartData/daily/${args.date}`);
      if (isEmpty(floors)) return `No floors data found for ${args.date}`;
      return floors;
    },
  },
  {
    name: "get_rhr_day",
    desc: "Get resting heart rate data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const rhr = await ctx.api(`/userstats-service/wellness/daily/${await ctx.displayName()}`, {
        params: { fromDate: args.date, untilDate: args.date, metricId: "60" },
      });
      if (isEmpty(rhr)) return `No resting heart rate data found for ${args.date}`;
      return rhr;
    },
  },
  {
    name: "get_heart_rates",
    desc: "Get full heart rate time-series data. Note: This returns detailed 2-minute interval data (~25KB). For a compact summary, use get_heart_rates_summary().",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const hr = await heartRates(ctx, args.date);
      if (isEmpty(hr)) return `No heart rate data found for ${args.date}`;
      return hr;
    },
  },
  {
    name: "get_heart_rates_summary",
    desc: "Get heart rate summary with essential metrics (lightweight version). Returns a compact summary (~500 bytes) instead of full time-series data (~25KB). Ideal for daily health checkups and LLM integrations.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const hr = await heartRates(ctx, args.date);
      if (isEmpty(hr)) return `No heart rate data found for ${args.date}`;
      const summary: Record<string, any> = {
        date: hr.calendarDate,
        max_heart_rate_bpm: hr.maxHeartRate,
        min_heart_rate_bpm: hr.minHeartRate,
        resting_heart_rate_bpm: hr.restingHeartRate,
        last_7_days_avg_resting_hr: hr.lastSevenDaysAvgRestingHeartRate,
      };
      const values = ((hr.heartRateValues ?? []) as [number, number | null][])
        .map((v) => v[1])
        .filter((v): v is number => typeof v === "number" && v > 0);
      if (values.length > 0) {
        summary.avg_heart_rate_bpm = round(values.reduce((a, b) => a + b, 0) / values.length, 1);
        summary.data_points_count = values.length;
      }
      return stripNulls(summary);
    },
  },
  {
    name: "get_hydration_data",
    desc: "Get hydration data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const hydration = await ctx.api(
        `/usersummary-service/usersummary/hydration/daily/${args.date}`
      );
      if (isEmpty(hydration)) return `No hydration data found for ${args.date}`;
      return hydration;
    },
  },
  {
    name: "get_sleep_data",
    desc: "Get full sleep data with all details. Note: This returns detailed sleep data (~50KB). For a compact summary, use get_sleep_summary().",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const sleep = await sleepData(ctx, args.date);
      if (isEmpty(sleep)) return `No sleep data found for ${args.date}`;
      return sleep;
    },
  },
  {
    name: "get_sleep_summary",
    desc: "Get sleep summary with only essential metrics (lightweight version). This endpoint returns a compact summary of sleep data (~350 bytes) instead of the full granular data (~50KB). Ideal for daily health checkups and LLM integrations where the full time-series data would overwhelm the context window.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const sleep = await sleepData(ctx, args.date);
      if (isEmpty(sleep)) return `No sleep summary found for ${args.date}`;
      const summary: Record<string, any> = {};
      const daily = sleep.dailySleepDTO;
      if (!isEmpty(daily)) {
        summary.sleep_seconds = daily.sleepTimeSeconds;
        summary.nap_seconds = daily.napTimeSeconds;
        summary.sleep_start = daily.sleepStartTimestampGMT;
        summary.sleep_end = daily.sleepEndTimestampGMT;
        summary.sleep_score = daily.sleepScores?.overall?.value;
        summary.sleep_score_qualifier = daily.sleepScores?.overall?.qualifierKey;
        summary.deep_sleep_seconds = daily.deepSleepSeconds;
        summary.light_sleep_seconds = daily.lightSleepSeconds;
        summary.rem_sleep_seconds = daily.remSleepSeconds;
        summary.awake_seconds = daily.awakeSleepSeconds;
        summary.awake_count = daily.awakeCount;
        summary.restless_moments_count = daily.restlessMomentsCount;
        summary.avg_sleep_stress = daily.avgSleepStress;
        summary.resting_heart_rate_bpm = daily.restingHeartRate;
      }
      const spo2 = sleep.wellnessSpO2SleepSummaryDTO;
      if (!isEmpty(spo2)) {
        summary.avg_spo2_percent = spo2.averageSpo2;
        summary.lowest_spo2_percent = spo2.lowestSpo2;
      }
      if ("avgOvernightHrv" in sleep) summary.avg_overnight_hrv = sleep.avgOvernightHrv;
      const total = summary.sleep_seconds ?? 0;
      if (total > 0) {
        summary.deep_sleep_percent = round(((summary.deep_sleep_seconds ?? 0) / total) * 100, 1);
        summary.light_sleep_percent = round(((summary.light_sleep_seconds ?? 0) / total) * 100, 1);
        summary.rem_sleep_percent = round(((summary.rem_sleep_seconds ?? 0) / total) * 100, 1);
        summary.sleep_hours = round(total / 3600, 2);
      }
      const result = stripNulls(summary);
      return Object.keys(result).length ? result : `No sleep summary found for ${args.date}`;
    },
  },
  {
    name: "get_stress_data",
    desc: "Get full stress time-series data. Note: This returns detailed interval data (~35KB) including body battery. For a compact summary, use get_stress_summary().",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const stress = await stressData(ctx, args.date);
      if (isEmpty(stress)) return `No stress data found for ${args.date}`;
      return stress;
    },
  },
  {
    name: "get_stress_summary",
    desc: "Get stress summary with essential metrics (lightweight version). Returns a compact summary (~400 bytes) instead of full time-series data (~35KB). Ideal for daily health checkups and LLM integrations.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const stress = await stressData(ctx, args.date);
      if (isEmpty(stress)) return `No stress data found for ${args.date}`;
      const summary: Record<string, any> = {
        date: stress.calendarDate,
        max_stress_level: stress.maxStressLevel,
        avg_stress_level: stress.avgStressLevel,
      };
      const raw = (stress.stressValuesArray ?? []) as [number, number | null][];
      if (raw.length > 0) {
        // -1/-2 are gap/activity sentinels; > 0 filter drops them
        const valid = raw.map((v) => v[1]).filter((v): v is number => typeof v === "number" && v > 0);
        const total = valid.length || 1;
        summary.rest_percent = round((valid.filter((v) => v < 26).length / total) * 100, 1);
        summary.low_stress_percent = round((valid.filter((v) => v >= 26 && v < 51).length / total) * 100, 1);
        summary.medium_stress_percent = round((valid.filter((v) => v >= 51 && v < 76).length / total) * 100, 1);
        summary.high_stress_percent = round((valid.filter((v) => v >= 76).length / total) * 100, 1);
        summary.data_points_count = valid.length;
      }
      return stripNulls(summary);
    },
  },
  {
    name: "get_respiration_data",
    desc: "Get full respiration time-series data. Note: This returns detailed interval data (~20KB). For a compact summary, use get_respiration_summary().",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const resp = await respirationData(ctx, args.date);
      if (isEmpty(resp)) return `No respiration data found for ${args.date}`;
      return resp;
    },
  },
  {
    name: "get_respiration_summary",
    desc: "Get respiration summary with essential metrics (lightweight version). Returns a compact summary (~300 bytes) instead of full time-series data (~20KB).",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const resp = await respirationData(ctx, args.date);
      if (isEmpty(resp)) return `No respiration data found for ${args.date}`;
      return stripNulls({
        date: resp.calendarDate,
        lowest_breaths_per_min: resp.lowestRespirationValue,
        highest_breaths_per_min: resp.highestRespirationValue,
        avg_waking_breaths_per_min: resp.avgWakingRespirationValue,
        avg_sleep_breaths_per_min: resp.avgSleepRespirationValue,
      });
    },
  },
  {
    name: "get_spo2_data",
    desc: "Get SpO2 (blood oxygen) data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const spo2 = (await ctx.api(`/wellness-service/wellness/daily/spo2/${args.date}`)) as Record<
        string,
        any
      >;
      if (isEmpty(spo2)) return `No SpO2 data found for ${args.date}`;
      // API occasionally returns this as a string
      let sevenDay = spo2.lastSevenDaysAvgSpO2;
      if (typeof sevenDay === "string") {
        const n = parseFloat(sevenDay);
        sevenDay = isNaN(n) ? sevenDay : n;
      }
      const summary: Record<string, any> = {
        date: spo2.calendarDate,
        avg_spo2_percent: spo2.averageSpO2,
        lowest_spo2_percent: spo2.lowestSpO2,
        latest_spo2_percent: spo2.latestSpO2,
        latest_reading_time: spo2.latestSpO2TimestampLocal,
        last_7_days_avg_spo2: sevenDay,
        avg_sleep_spo2_percent: spo2.avgSleepSpO2,
      };
      if (!isEmpty(spo2.spO2HourlyAverages)) summary.hourly_averages = spo2.spO2HourlyAverages;
      return stripNulls(summary);
    },
  },
  {
    name: "get_all_day_stress",
    desc: "Get all-day stress data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const stress = await stressData(ctx, args.date);
      if (isEmpty(stress)) return `No all-day stress data found for ${args.date}`;
      return stress;
    },
  },
  {
    name: "get_all_day_events",
    desc: "Get daily wellness events data",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const events = await ctx.api("/wellness-service/wellness/dailyEvents", {
        params: { calendarDate: args.date },
      });
      if (isEmpty(events)) return `No daily wellness events found for ${args.date}`;
      return events;
    },
  },
  {
    name: "get_lifestyle_logging_data",
    desc: "Get lifestyle logging data for a specific date. Returns lifestyle logging data which allows users to track behaviors and their impact on health metrics.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const data = await ctx.api(`/lifestylelogging-service/dailyLog/${args.date}`);
      if (isEmpty(data)) return `No lifestyle logging data found for ${args.date}`;
      return data;
    },
  },
  {
    name: "get_weekly_steps",
    desc: "Get weekly step data aggregates. Returns weekly step totals for the specified number of weeks ending at end_date.",
    params: { end_date: dateStr.describe("End date in YYYY-MM-DD format"), weeks: weeksParam },
    run: async (args, ctx) => {
      const weeks = Math.min(args.weeks, 52);
      const data = (await ctx.api(
        `/usersummary-service/stats/steps/weekly/${args.end_date}/${weeks}`
      )) as Record<string, any>[];
      if (isEmpty(data)) return `No weekly steps data found for ${weeks} weeks ending ${args.end_date}`;
      const curated = data.map((week) => {
        const values = week.values ?? {};
        return stripNulls({
          week_start: week.calendarDate,
          total_steps: values.totalSteps,
          average_steps: values.averageSteps,
          total_distance_meters: values.totalDistance,
          average_distance_meters: values.averageDistance,
          days_with_data: values.wellnessDataDaysCount,
        }) as Record<string, any>;
      });
      sortByWeekDesc(curated);
      return {
        end_date: args.end_date,
        weeks_requested: weeks,
        weeks_returned: curated.length,
        weekly_data: curated,
      };
    },
  },
  {
    name: "get_weekly_stress",
    desc: "Get weekly stress data aggregates. Returns weekly stress values for the specified number of weeks ending at end_date.",
    params: { end_date: dateStr.describe("End date in YYYY-MM-DD format"), weeks: weeksParam },
    run: async (args, ctx) => {
      const weeks = Math.min(args.weeks, 52);
      const data = (await ctx.api(
        `/usersummary-service/stats/stress/weekly/${args.end_date}/${weeks}`
      )) as Record<string, any>[];
      if (isEmpty(data)) return `No weekly stress data found for ${weeks} weeks ending ${args.end_date}`;
      const curated = data.map(
        (week) =>
          stripNulls({
            week_start: week.calendarDate,
            stress_value: week.value,
          }) as Record<string, any>
      );
      sortByWeekDesc(curated);
      return {
        end_date: args.end_date,
        weeks_requested: weeks,
        weeks_returned: curated.length,
        weekly_data: curated,
      };
    },
  },
  {
    name: "get_weekly_intensity_minutes",
    desc: "Get weekly intensity minutes data aggregates. Returns weekly intensity minutes (moderate and vigorous) for the specified number of weeks ending at end_date.",
    params: { end_date: dateStr.describe("End date in YYYY-MM-DD format"), weeks: weeksParam },
    run: async (args, ctx) => {
      const weeks = Math.min(args.weeks, 52);
      const startDate = isoDate(addDays(parseDate(args.end_date), -(weeks * 7 - 1)));
      const data = (await ctx.api(
        `/usersummary-service/stats/im/weekly/${startDate}/${args.end_date}`
      )) as Record<string, any>[];
      if (isEmpty(data))
        return `No weekly intensity minutes data found for ${weeks} weeks ending ${args.end_date}`;
      const curated = data.map(
        (week) =>
          stripNulls({
            week_start: week.calendarDate,
            weekly_goal: week.weeklyGoal,
            moderate_minutes: week.moderateValue,
            vigorous_minutes: week.vigorousValue,
            total_minutes: (week.moderateValue ?? 0) + (week.vigorousValue ?? 0),
          }) as Record<string, any>
      );
      sortByWeekDesc(curated);
      return {
        end_date: args.end_date,
        weeks_requested: weeks,
        weeks_returned: curated.length,
        weekly_data: curated,
      };
    },
  },
  {
    name: "get_morning_training_readiness",
    desc: "Get morning training readiness score. Returns the morning training readiness assessment, which evaluates recovery status and readiness to train based on overnight metrics.",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const list = await trainingReadiness(ctx, args.date);
      if (isEmpty(list)) return `No morning training readiness data found for ${args.date}`;
      // AFTER_WAKEUP_RESET is the morning snapshot; fall back to first entry
      const r = list.find((e) => e.inputContext === "AFTER_WAKEUP_RESET") ?? list[0];
      return stripNulls({
        date: args.date,
        readiness_score: r.readinessScore,
        readiness_level: r.readinessLevel,
        recovery_time_hours: r.recoveryTime != null ? round(r.recoveryTime / 60, 1) : null,
        hrv_status: r.hrvStatus,
        sleep_quality: r.sleepQuality,
        sleep_score: r.sleepScore,
        resting_heart_rate_bpm: r.restingHeartRate,
        hrv_baseline: r.hrvBaseline,
        hrv_last_night: r.hrvLastNight,
        body_battery_percent: r.bodyBattery,
        stress_level: r.stressLevel,
        training_load_balance: r.trainingLoadBalance,
        acute_load: r.acuteLoad,
        chronic_load: r.chronicLoad,
      });
    },
  },
];
