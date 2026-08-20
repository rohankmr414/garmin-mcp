import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { dateStr, stripNulls, assertSpan, eachDate } from "../toolkit";

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

// Garmin sections may be null, a list, or another shape
function asDict(v: unknown): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

// device-keyed maps: prefer the primary training device, else first device
function pickDevice(map: Record<string, any>): Record<string, any> {
  let first: Record<string, any> = {};
  for (const v of Object.values(map)) {
    if (!v || typeof v !== "object") continue;
    if ((v as Record<string, any>).primaryTrainingDevice) return v as Record<string, any>;
    if (Object.keys(first).length === 0) first = v as Record<string, any>;
  }
  return first;
}

// module-level cache; persists for the isolate's lifetime, {} on error (never retried)
let activityTypeCache: Record<number, string> | undefined;

async function activityTypeMapping(ctx: Ctx): Promise<Record<number, string>> {
  if (activityTypeCache !== undefined) return activityTypeCache;
  let mapping: Record<number, string> = {};
  try {
    const types = (await ctx.api("/activity-service/activity/activityTypes")) as Record<string, any>[];
    mapping = Object.fromEntries(
      (Array.isArray(types) ? types : [])
        .filter((t) => t?.typeId != null)
        .map((t) => [t.typeId, t.typeKey ?? "unknown"])
    );
  } catch {
    // leave empty; cached so it is not retried (matches the Python behavior)
  }
  activityTypeCache = mapping;
  return mapping;
}

function mapContributor(c: Record<string, any>, mapping: Record<number, string>): Record<string, any> {
  const out: Record<string, any> = {
    contribution_percent: c.contribution ? r2(c.contribution) : null,
  };
  if (c.activityTypeId != null) {
    out.activity_type = mapping[c.activityTypeId] ?? `unknown_${c.activityTypeId}`;
    out.activity_type_id = c.activityTypeId;
  } else if (c.group != null) {
    const groupNames: Record<number, string> = { 0: "running (?)", 1: "biking (?)", 8: "Other Activities" };
    out.group = groupNames[c.group] ?? `group_${c.group}`;
  }
  return out;
}

// Find all VO2 max values by sport in known Garmin response shapes
function extractVo2Measurements(data: unknown): Record<string, number> {
  if (Array.isArray(data)) {
    const out: Record<string, number> = {};
    for (const item of data) {
      for (const [sport, value] of Object.entries(extractVo2Measurements(item))) out[sport] ??= value;
    }
    return out;
  }
  const d = asDict(data);
  // Garmin uses "generic" for its running/non-cycling VO2 max series
  const candidatePaths: [string[], string][] = [
    [["vo2MaxRunning"], "running"],
    [["vo2MaxCycling"], "cycling"],
    [["vo2Max"], "running"],
    [["vo2MaxValue"], "running"],
    [["vo2MaxPreciseValue"], "running"],
    [["generic", "vo2MaxValue"], "running"],
    [["generic", "vo2MaxPreciseValue"], "running"],
    [["cycling", "vo2MaxValue"], "cycling"],
    [["cycling", "vo2MaxPreciseValue"], "cycling"],
    [["mostRecentVO2Max", "generic", "vo2MaxValue"], "running"],
    [["mostRecentVO2Max", "generic", "vo2MaxPreciseValue"], "running"],
    [["mostRecentVO2Max", "cycling", "vo2MaxValue"], "cycling"],
    [["mostRecentVO2Max", "cycling", "vo2MaxPreciseValue"], "cycling"],
    [["userData", "vo2MaxRunning"], "running"],
    [["userData", "vo2MaxCycling"], "cycling"],
  ];
  const out: Record<string, number> = {};
  for (const [path, sport] of candidatePaths) {
    let cur: any = d;
    for (const key of path) cur = asDict(cur)[key];
    if (out[sport] === undefined && typeof cur === "number" && isFinite(cur)) out[sport] = cur;
  }
  return out;
}

// Index max-metrics range values by calendar date and sport
function extractDatedVo2Measurements(data: unknown): Record<string, Record<string, number>> {
  const byDate: Record<string, Record<string, number>> = {};
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(collect);
      return;
    }
    const d = asDict(item);
    for (const [sport, value] of Object.entries(extractVo2Measurements(d))) {
      const section = asDict(d[sport === "running" ? "generic" : "cycling"]);
      const calendarDate = section.calendarDate ?? d.calendarDate;
      if (typeof calendarDate === "string") (byDate[calendarDate] ??= {})[sport] ??= value;
    }
  };
  collect(data);
  return byDate;
}

function trainingStatus(ctx: Ctx, date: string): Promise<unknown> {
  return ctx.api(`/metrics-service/metrics/trainingstatus/aggregated/${date}`);
}

export const tools: ToolDef[] = [
  {
    name: "get_progress_summary_between_dates",
    desc: "Get progress summary for a metric between dates",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
      metric: z
        .string()
        .describe('Metric to get progress for (e.g., "elevationGain", "duration", "distance", "movingDuration")'),
    },
    run: async (args, ctx) => {
      const { start_date, end_date, metric } = args;
      const raw = (await ctx.api("/fitnessstats-service/activity", {
        params: {
          startDate: start_date,
          endDate: end_date,
          aggregation: "lifetime",
          groupByParentActivityType: "true",
          metric,
        },
      })) as unknown;
      if (Array.isArray(raw) ? raw.length === 0 : !raw) {
        return { message: `No progress summary found for ${metric} between ${start_date} and ${end_date}.` };
      }
      if (!Array.isArray(raw)) return { message: "Unexpected response format from API" };
      const data = asDict(raw[0]);
      const statsByType: Record<string, any> = {};
      for (const [activityType, activityStats] of Object.entries(asDict(data.stats))) {
        const m = asDict(activityStats)[metric];
        if (m && (m.count ?? 0) > 0) {
          statsByType[activityType] = { count: m.count, sum: m.sum, avg: m.avg, min: m.min, max: m.max };
        }
      }
      return stripNulls({
        metric,
        start_date,
        end_date,
        date: data.date,
        count_of_activities: data.countOfActivities,
        stats_by_activity_type: statsByType,
      });
    },
  },
  {
    name: "get_hill_score",
    desc: "Get hill score data between dates",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      const data = asDict(
        await ctx.api("/metrics-service/metrics/hillscore/stats", {
          params: { startDate: start_date, endDate: end_date, aggregation: "daily" },
        })
      );
      if (Object.keys(data).length === 0) {
        return { message: `No hill score data found between ${start_date} and ${end_date}.` };
      }
      const avgScore = Object.values(asDict(data.periodAvgScore))[0];
      const dailyScores = (Array.isArray(data.hillScoreDTOList) ? data.hillScoreDTOList : []) as Record<string, any>[];
      const latest = asDict(dailyScores[0]);
      return stripNulls({
        start_date,
        end_date,
        period_avg_score: avgScore,
        max_score: data.maxScore,
        latest_date: latest.calendarDate,
        latest_overall_score: latest.overallScore,
        latest_strength_score: latest.strengthScore,
        latest_endurance_score: latest.enduranceScore,
        latest_classification_id: latest.hillScoreClassificationId,
        daily_scores: dailyScores.map((s) => ({
          date: s.calendarDate,
          overall: s.overallScore,
          strength: s.strengthScore,
          endurance: s.enduranceScore,
        })),
      });
    },
  },
  {
    name: "get_endurance_score",
    desc: "Get endurance score data between dates",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      const data = asDict(
        await ctx.api("/metrics-service/metrics/endurancescore/stats", {
          params: { startDate: start_date, endDate: end_date, aggregation: "weekly" },
        })
      );
      if (Object.keys(data).length === 0) {
        return { message: `No endurance score data found between ${start_date} and ${end_date}.` };
      }
      const mapping = await activityTypeMapping(ctx);
      const scoreDto = asDict(data.enduranceScoreDTO);
      const classificationLabels: Record<number, string> = {
        1: "recreational",
        2: "intermediate",
        3: "trained",
        4: "well_trained",
        5: "expert",
        6: "superior",
        7: "elite",
      };
      const classificationId = scoreDto.classification;
      const classificationLabel =
        classificationId != null ? classificationLabels[classificationId] ?? `level_${classificationId}` : null;
      const rawContributors = (Array.isArray(scoreDto.contributors) ? scoreDto.contributors : []) as Record<
        string,
        any
      >[];
      const contributors = rawContributors.length ? rawContributors.map((c) => mapContributor(c, mapping)) : null;
      const weeklyBreakdown = Object.entries(asDict(data.groupMap))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([weekDate, weekData]) => {
          const wd = asDict(weekData);
          const weekContributors = (
            (Array.isArray(wd.enduranceContributorDTOList) ? wd.enduranceContributorDTOList : []) as Record<
              string,
              any
            >[]
          ).map((c) => mapContributor(c, mapping));
          return {
            week_start: weekDate,
            avg_score: wd.groupAverage,
            max_score: wd.groupMax,
            contributors: weekContributors.length ? weekContributors : null,
          };
        });
      return stripNulls({
        start_date,
        end_date,
        period_avg_score: data.avg,
        period_max_score: data.max,
        current_score: scoreDto.overallScore,
        current_date: scoreDto.calendarDate,
        classification: classificationLabel,
        classification_id: classificationId,
        thresholds: scoreDto.classificationLowerLimitTrained
          ? {
              intermediate: scoreDto.classificationLowerLimitIntermediate,
              trained: scoreDto.classificationLowerLimitTrained,
              well_trained: scoreDto.classificationLowerLimitWellTrained,
              expert: scoreDto.classificationLowerLimitExpert,
              superior: scoreDto.classificationLowerLimitSuperior,
              elite: scoreDto.classificationLowerLimitElite,
            }
          : null,
        contributors,
        weekly_breakdown: weeklyBreakdown.length ? weeklyBreakdown : null,
      });
    },
  },
  {
    name: "get_training_effect",
    desc: "Get training effect data for a specific activity",
    params: {
      activity_id: z.number().describe("ID of the activity to retrieve training effect for"),
    },
    run: async (args, ctx) => {
      const activity = asDict(await ctx.api(`/activity-service/activity/${args.activity_id}`));
      if (Object.keys(activity).length === 0) {
        return { message: `No activity found with ID ${args.activity_id}.` };
      }
      const summary = asDict(activity.summaryDTO);
      return stripNulls({
        activity_id: args.activity_id,
        training_effect: summary.trainingEffect,
        aerobic_effect: summary.trainingEffect,
        anaerobic_effect: summary.anaerobicTrainingEffect,
        training_effect_label: summary.trainingEffectLabel,
        recovery_time_hours: summary.recoveryTime ? r1(summary.recoveryTime / 60) : null,
        training_load: summary.activityTrainingLoad,
        performance_condition: summary.performanceCondition,
      });
    },
  },
  {
    name: "get_hrv_data",
    desc: "Get Heart Rate Variability (HRV) data",
    params: {
      date: dateStr,
      return_timeseries: z
        .boolean()
        .optional()
        .describe("If true, include detailed 5-minute HRV readings (can be large)"),
    },
    run: async (args, ctx) => {
      const hrvData = asDict(await ctx.api(`/hrv-service/hrv/${args.date}`));
      if (Object.keys(hrvData).length === 0) return { message: `No HRV data found for ${args.date}.` };
      const summary = asDict(hrvData.hrvSummary);
      const baseline = asDict(summary.baseline);
      const curated: Record<string, any> = {
        date: summary.calendarDate ?? args.date,
        last_night_avg_hrv_ms: summary.lastNightAvg,
        last_night_5min_high_hrv_ms: summary.lastNight5MinHigh,
        weekly_avg_hrv_ms: summary.weeklyAvg,
        baseline_balanced_low_ms: baseline.balancedLow,
        baseline_balanced_upper_ms: baseline.balancedUpper,
        baseline_low_upper_ms: baseline.lowUpper,
        status: summary.status,
        feedback: summary.feedbackPhrase,
        sleep_start: hrvData.sleepStartTimestampLocal,
        sleep_end: hrvData.sleepEndTimestampLocal,
      };
      if (args.return_timeseries) {
        const readings = (Array.isArray(hrvData.hrvReadings) ? hrvData.hrvReadings : []) as Record<string, any>[];
        curated.hrv_readings = readings.map((r) => ({ time: r.readingTimeLocal, hrv_ms: r.hrvValue }));
        curated.readings_count = readings.length;
      }
      return stripNulls(curated);
    },
  },
  {
    name: "get_fitnessage_data",
    desc: "Get fitness age data",
    params: {
      date: dateStr,
      details: z
        .boolean()
        .optional()
        .describe("If true, include component breakdown (BMI, RHR, vigorous activity) with targets and improvement suggestions"),
    },
    run: async (args, ctx) => {
      const fitnessAge = asDict(await ctx.api(`/fitnessage-service/fitnessage/${args.date}`));
      if (Object.keys(fitnessAge).length === 0) return { message: `No fitness age data found for ${args.date}.` };
      const chronoAge = fitnessAge.chronologicalAge;
      const fitAge = fitnessAge.fitnessAge;
      const curated: Record<string, any> = {
        date: args.date,
        fitness_age_years: fitAge ? r1(fitAge) : null,
        chronological_age_years: chronoAge,
        age_difference_years: chronoAge != null && fitAge != null ? r1(chronoAge - fitAge) : null,
        achievable_fitness_age_years: fitnessAge.achievableFitnessAge ? r1(fitnessAge.achievableFitnessAge) : null,
        previous_fitness_age_years: fitnessAge.previousFitnessAge ? r1(fitnessAge.previousFitnessAge) : null,
        last_updated: fitnessAge.lastUpdated,
      };
      if (args.details) {
        const components: Record<string, any> = {};
        for (const [name, compData] of Object.entries(asDict(fitnessAge.components))) {
          const comp = asDict(compData);
          if (Object.keys(comp).length === 0) continue;
          const info: Record<string, any> = { value: comp.value };
          if (comp.targetValue != null) info.target = comp.targetValue;
          if (comp.improvementValue != null) info.improvement_needed = comp.improvementValue;
          if (comp.potentialAge != null) info.potential_age_if_improved = r1(comp.potentialAge);
          if (comp.priority != null) info.priority = comp.priority;
          if (comp.stale != null) info.stale = comp.stale;
          if (comp.lastMeasurementDate != null) info.last_measurement = comp.lastMeasurementDate;
          components[name] = info;
        }
        if (Object.keys(components).length) curated.components = components;
      }
      return stripNulls(curated);
    },
  },
  {
    name: "get_training_status",
    desc: "Get training status with curated metrics: load, VO2 max, recovery, and training readiness indicators",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const status = asDict(await trainingStatus(ctx, args.date));
      if (Object.keys(status).length === 0) {
        return { message: `No training status data found for ${args.date}.` };
      }
      const latestData = asDict(asDict(status.mostRecentTrainingStatus).latestTrainingStatusData);
      const deviceData = pickDevice(latestData);
      const acwr = asDict(deviceData.acuteTrainingLoadDTO);
      const vo2 = asDict(asDict(status.mostRecentVO2Max).generic);
      const cyclingVo2 = asDict(asDict(status.mostRecentVO2Max).cycling);
      const loadMap = asDict(asDict(status.mostRecentTrainingLoadBalance).metricsTrainingLoadBalanceDTOMap);
      const loadData = pickDevice(loadMap);
      return stripNulls({
        date: deviceData.calendarDate ?? args.date,
        training_status: deviceData.trainingStatus,
        training_status_feedback: deviceData.trainingStatusFeedbackPhrase,
        sport: deviceData.sport,
        fitness_trend: deviceData.fitnessTrend,
        acute_load: acwr.dailyTrainingLoadAcute,
        chronic_load: acwr.dailyTrainingLoadChronic,
        load_ratio: acwr.dailyAcuteChronicWorkloadRatio,
        acwr_status: acwr.acwrStatus,
        acwr_percent: acwr.acwrPercent,
        optimal_chronic_load_min: acwr.minTrainingLoadChronic,
        optimal_chronic_load_max: acwr.maxTrainingLoadChronic,
        vo2_max: vo2.vo2MaxValue,
        vo2_max_precise: vo2.vo2MaxPreciseValue,
        cycling_vo2_max: cyclingVo2.vo2MaxValue,
        cycling_vo2_max_precise: cyclingVo2.vo2MaxPreciseValue,
        monthly_load_aerobic_low: loadData.monthlyLoadAerobicLow,
        monthly_load_aerobic_high: loadData.monthlyLoadAerobicHigh,
        monthly_load_anaerobic: loadData.monthlyLoadAnaerobic,
        training_balance_feedback: loadData.trainingBalanceFeedbackPhrase,
      });
    },
  },
  {
    name: "get_cycling_ftp",
    desc: "Get the latest cycling Functional Threshold Power (FTP) estimate available from Garmin",
    run: async (_args, ctx) => {
      const raw = await ctx.api("/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING");
      const ftp = Array.isArray(raw) ? asDict(raw[0]) : asDict(raw);
      if (Object.keys(ftp).length === 0) return { message: "No cycling FTP data found" };
      return stripNulls({
        sport: ftp.sport,
        functional_threshold_power_watts: ftp.functionalThresholdPower,
        calendar_date: ftp.calendarDate,
        is_stale: ftp.isStale,
        biometric_source_type: ftp.biometricSourceType,
      });
    },
  },
  {
    name: "get_lactate_threshold",
    desc: "Get lactate threshold data (running speed, heart rate, and power at threshold). Omit both dates for the latest values; pass both for history over a range.",
    params: {
      start_date: dateStr.optional().describe("Start date in YYYY-MM-DD format (optional, omit for latest)"),
      end_date: dateStr.optional().describe("End date in YYYY-MM-DD format (optional, omit for latest)"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      if (start_date && end_date) {
        const params = { sport: "RUNNING", aggregation: "daily", aggregationStrategy: "LATEST" };
        const [speed, heartRate, power] = await Promise.all([
          ctx.api(`/biometric-service/stats/lactateThresholdSpeed/range/${start_date}/${end_date}`, { params }),
          ctx.api(`/biometric-service/stats/lactateThresholdHeartRate/range/${start_date}/${end_date}`, { params }),
          ctx.api(`/biometric-service/stats/functionalThresholdPower/range/${start_date}/${end_date}`, { params }),
        ]);
        const asList = (v: unknown) => (Array.isArray(v) ? (v as Record<string, any>[]) : []);
        const history = (entries: Record<string, any>[], valueKey: string) =>
          entries.map((e) => ({ date: e.from, [valueKey]: e.value, series: e.series }));
        const speedHistory = asList(speed);
        const hrHistory = asList(heartRate);
        const powerHistory = asList(power);
        if (!speedHistory.length && !hrHistory.length && !powerHistory.length) {
          return { message: `No lactate threshold data found between ${start_date} and ${end_date}` };
        }
        return stripNulls({
          start_date,
          end_date,
          speed_history: speedHistory.length ? history(speedHistory, "speed_mps") : null,
          heart_rate_history: hrHistory.length ? history(hrHistory, "heart_rate_bpm") : null,
          power_history: powerHistory.length ? history(powerHistory, "power_watts") : null,
        });
      }
      const today = new Date().toISOString().slice(0, 10);
      const [powerRaw, thresholdRaw] = await Promise.all([
        ctx.api(`/biometric-service/biometric/powerToWeight/latest/${today}`, { params: { sport: "Running" } }),
        ctx.api("/biometric-service/biometric/latestLactateThreshold"),
      ]);
      const power = Array.isArray(powerRaw) ? asDict(powerRaw[0]) : asDict(powerRaw);
      // latestLactateThreshold returns a list of nearly identical dicts; merge them
      const speedHr: Record<string, any> = {};
      for (const entry of Array.isArray(thresholdRaw) ? (thresholdRaw as Record<string, any>[]) : []) {
        if (entry.speed != null) {
          speedHr.calendarDate = entry.calendarDate;
          speedHr.speed = entry.speed;
        }
        // prefer correct key; fall back to Garmin's historical typo ("hearRate")
        const hr = entry.heartRate ?? entry.hearRate;
        if (hr != null) speedHr.heartRate = hr;
        if (entry.heartRateCycling != null) speedHr.heartRateCycling = entry.heartRateCycling;
      }
      if (Object.keys(speedHr).length === 0 && Object.keys(power).length === 0) {
        return { message: "No lactate threshold data found" };
      }
      return stripNulls({
        lactate_threshold_speed_mps: speedHr.speed,
        lactate_threshold_heart_rate_bpm: speedHr.heartRate,
        heart_rate_cycling_bpm: speedHr.heartRateCycling,
        speed_hr_date: speedHr.calendarDate,
        functional_threshold_power_watts: power.functionalThresholdPower,
        weight_kg: power.weight,
        power_to_weight: power.powerToWeight,
        sport: power.sport,
        power_date: power.calendarDate,
        is_stale: power.isStale,
      });
    },
  },
  {
    name: "request_reload",
    desc: "Request reload of epoch data (Garmin offloads older data; this asks it to re-materialize a date)",
    params: { date: dateStr },
    run: (args, ctx) => ctx.api(`/wellness-service/wellness/epoch/request/${args.date}`, { method: "POST" }),
  },
  {
    name: "get_training_load_trend",
    desc: "Get the Performance Management Chart (CTL/ATL/TSB) over a date range. Returns Chronic Training Load (CTL, 42-day fitness), Acute Training Load (ATL, 7-day fatigue), Training Stress Balance (TSB = CTL - ATL, form/freshness), and ACWR per day. Recommended range: 4-8 weeks. Maximum: 45 days (reduced from 90: one API call per day, and Cloudflare Workers allows ~50 subrequests per invocation).",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      assertSpan(start_date, end_date, 45);
      const days = eachDate(start_date, end_date);
      const results = await Promise.all(
        days.map((d) => trainingStatus(ctx, d).catch(() => null)) // skip days with no data
      );
      const trend: Record<string, any>[] = [];
      for (let i = 0; i < days.length; i++) {
        const data = asDict(results[i]);
        if (Object.keys(data).length === 0) continue;
        const latestData = asDict(asDict(data.mostRecentTrainingStatus).latestTrainingStatusData);
        const statusData = pickDevice(latestData);
        const atlDto = asDict(statusData.acuteTrainingLoadDTO);
        const vo2Data = asDict(asDict(data.mostRecentVO2Max).generic);
        const entry: Record<string, any> = { date: days[i] };
        const atl = atlDto.dailyTrainingLoadAcute;
        const ctl = atlDto.dailyTrainingLoadChronic;
        const acwr = atlDto.dailyAcuteChronicWorkloadRatio;
        if (atl != null) entry.atl = r1(atl);
        if (ctl != null) entry.ctl = r1(ctl);
        if (atl != null && ctl != null) entry.tsb = r1(ctl - atl);
        if (acwr != null) entry.acwr = r2(acwr);
        if (atlDto.acwrStatus) entry.acwr_status = atlDto.acwrStatus;
        if (atlDto.acwrPercent != null) entry.acwr_percent = atlDto.acwrPercent;
        if (atlDto.minTrainingLoadChronic != null) entry.optimal_chronic_load_min = r1(atlDto.minTrainingLoadChronic);
        if (atlDto.maxTrainingLoadChronic != null) entry.optimal_chronic_load_max = r1(atlDto.maxTrainingLoadChronic);
        if (statusData.trainingStatusFeedbackPhrase) entry.training_status = statusData.trainingStatusFeedbackPhrase;
        if (statusData.trainingStatus != null) entry.training_status_code = statusData.trainingStatus;
        if (statusData.fitnessTrend != null) entry.fitness_trend = statusData.fitnessTrend;
        if (vo2Data.vo2MaxValue != null) entry.vo2_max = r1(vo2Data.vo2MaxValue);
        if (Object.keys(entry).length > 1) trend.push(entry);
      }
      if (!trend.length) return { message: `No training load data found between ${start_date} and ${end_date}.` };
      return { start_date, end_date, days_with_data: trend.length, trend };
    },
  },
  {
    name: "get_training_load_balance",
    desc: "Get Garmin's Load Focus: the trailing-month training load split across Aerobic Low, Aerobic High, and Anaerobic bands with target ranges, a below/within/above status per band, and the system's feedback phrase (e.g. AEROBIC_HIGH_SHORTAGE, BALANCED, ANAEROBIC_SHORTAGE)",
    params: { date: dateStr },
    run: async (args, ctx) => {
      const data = asDict(await trainingStatus(ctx, args.date));
      const loadMap = asDict(asDict(data.mostRecentTrainingLoadBalance).metricsTrainingLoadBalanceDTOMap);
      const loadData = pickDevice(loadMap);
      if (Object.keys(loadData).length === 0) {
        return { message: `No training load balance data found for ${args.date}.` };
      }
      const band = (loadKey: string, minKey: string, maxKey: string): Record<string, any> | null => {
        const load = loadData[loadKey];
        const tmin = loadData[minKey];
        const tmax = loadData[maxKey];
        if (load == null && tmin == null && tmax == null) return null;
        const b: Record<string, any> = {};
        if (load != null) b.load = r1(load);
        if (tmin != null) b.target_min = tmin;
        if (tmax != null) b.target_max = tmax;
        if (load != null && tmin != null && tmax != null) {
          b.status = load < tmin ? "below" : load > tmax ? "above" : "within";
        }
        return b;
      };
      const result: Record<string, any> = { date: loadData.calendarDate ?? args.date };
      if (loadData.trainingBalanceFeedbackPhrase) result.feedback = loadData.trainingBalanceFeedbackPhrase;
      const aerobicLow = band("monthlyLoadAerobicLow", "monthlyLoadAerobicLowTargetMin", "monthlyLoadAerobicLowTargetMax");
      if (aerobicLow) result.aerobic_low = aerobicLow;
      const aerobicHigh = band("monthlyLoadAerobicHigh", "monthlyLoadAerobicHighTargetMin", "monthlyLoadAerobicHighTargetMax");
      if (aerobicHigh) result.aerobic_high = aerobicHigh;
      const anaerobic = band("monthlyLoadAnaerobic", "monthlyLoadAnaerobicTargetMin", "monthlyLoadAnaerobicTargetMax");
      if (anaerobic) result.anaerobic = anaerobic;
      return result;
    },
  },
  {
    name: "get_hrv_trend",
    desc: "Get HRV (Heart Rate Variability) trend over a date range: daily values plus period average. Single-day HRV is too noisy to act on; use this to spot baseline shifts signalling accumulated fatigue or recovery (a >10ms drop from the 7-day baseline warrants reducing load). Recommended range: 7-21 days. Maximum: 30 days. Fetched via Garmin's HRV range endpoint in a single API call (instead of one call per day) to stay within Cloudflare Workers' ~50 subrequest limit.",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      assertSpan(start_date, end_date, 30);
      const raw = await ctx.api(`/hrv-service/hrv/daily/${start_date}/${end_date}`);
      const summaries = (Array.isArray(raw) ? raw : asDict(raw).hrvSummaries ?? []) as Record<string, any>[];
      const trend: Record<string, any>[] = [];
      for (const s of [...summaries].sort((a, b) => (a.calendarDate < b.calendarDate ? -1 : 1))) {
        const entry: Record<string, any> = { date: s.calendarDate };
        const lastNight = s.lastNightAvg ?? s.lastNight;
        if (lastNight != null) entry.last_night_avg_hrv_ms = r1(lastNight);
        if (s.weeklyAvg != null) entry.weekly_avg_hrv_ms = r1(s.weeklyAvg);
        if (s.lastNight5MinHigh != null) entry.last_night_5min_high_hrv_ms = r1(s.lastNight5MinHigh);
        if (s.status) entry.status = s.status;
        if (s.feedbackPhrase) entry.feedback = s.feedbackPhrase;
        if (Object.keys(entry).length > 1) trend.push(entry);
      }
      if (!trend.length) return { message: `No HRV data found between ${start_date} and ${end_date}.` };
      const values = trend.map((e) => e.last_night_avg_hrv_ms).filter((v): v is number => v != null);
      return {
        start_date,
        end_date,
        days_with_data: trend.length,
        period_avg_hrv_ms: values.length ? r1(values.reduce((a, b) => a + b, 0) / values.length) : null,
        trend,
      };
    },
  },
  {
    name: "get_vo2max_trend",
    desc: "Get VO2 max trend over a date range from Garmin's FirstBeat estimates. Track whether training produces fitness gains over weeks; daily changes of <0.5 are noise, focus on the 4-6 week direction. Maximum: 90 days. Uses the max-metrics range endpoint in one API call; missing dates fall back to per-day training status capped at 30 extra calls (Cloudflare Workers allows ~50 subrequests per invocation). If no historical values exist, the current profile estimate is returned separately and is not represented as a trend point.",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      assertSpan(start_date, end_date, 90);
      let rangeMeasurements: Record<string, Record<string, number>> = {};
      try {
        rangeMeasurements = extractDatedVo2Measurements(
          await ctx.api(`/metrics-service/metrics/maxmet/daily/${start_date}/${end_date}`)
        );
      } catch {
        // range endpoint failed; per-day fallback below still runs
      }
      const days = eachDate(start_date, end_date);
      // per-day training-status fallback for missing dates, capped at 30 extra calls
      const missing = days.filter((d) => !Object.keys(rangeMeasurements[d] ?? {}).length).slice(0, 30);
      const fallback: Record<string, Record<string, number>> = {};
      const fallbackResults = await Promise.all(
        missing.map((d) =>
          trainingStatus(ctx, d)
            .then(extractVo2Measurements)
            .catch(() => ({} as Record<string, number>))
        )
      );
      missing.forEach((d, i) => {
        fallback[d] = fallbackResults[i];
      });
      type Vo2Point = { date: string; vo2_max: number; source: string };
      const histories: Record<string, Vo2Point[]> = { running: [], cycling: [] };
      for (const d of days) {
        let measurements = rangeMeasurements[d] ?? {};
        let source = "get_max_metrics";
        if (!Object.keys(measurements).length) {
          measurements = fallback[d] ?? {};
          source = "get_training_status";
        }
        for (const [sport, vo2] of Object.entries(measurements)) {
          histories[sport]?.push({ date: d, vo2_max: r1(vo2), source });
        }
      }
      // prefer the sport with the best coverage; ties go to running
      const selectedSport =
        histories.running.length || histories.cycling.length
          ? histories.cycling.length > histories.running.length
            ? "cycling"
            : "running"
          : null;
      const trend: Vo2Point[] = [];
      let lastVo2: number | null = null;
      for (const entry of selectedSport ? histories[selectedSport] : []) {
        if (entry.vo2_max !== lastVo2) {
          trend.push(entry);
          lastVo2 = entry.vo2_max;
        }
      }
      let currentEstimate: number | null = null;
      let currentSport: string | null = null;
      if (!trend.length) {
        let profile: unknown = null;
        try {
          profile = await ctx.api("/userprofile-service/userprofile/user-settings");
        } catch {
          profile = null;
        }
        const profileMeasurements = extractVo2Measurements(profile);
        if (Object.keys(profileMeasurements).length) {
          currentSport = "running" in profileMeasurements ? "running" : "cycling";
          currentEstimate = profileMeasurements[currentSport] ?? null;
        } else {
          return { message: `No VO2 max data found between ${start_date} and ${end_date}.` };
        }
      }
      const firstVo2 = trend.length ? trend[0].vo2_max : null;
      const latestVo2 = trend.length ? trend[trend.length - 1].vo2_max : null;
      const response: Record<string, any> = {
        start_date,
        end_date,
        data_points: trend.length,
        first_vo2_max: firstVo2,
        latest_vo2_max: latestVo2,
        change: firstVo2 != null && latestVo2 != null ? r1(latestVo2 - firstVo2) : null,
        trend,
      };
      if (selectedSport != null) response.sport = selectedSport;
      if (currentEstimate != null) {
        response.current_vo2_max_estimate = {
          vo2_max: r1(currentEstimate),
          sport: currentSport,
          source: "get_user_profile",
        };
        response.note =
          "Historical VO2 max values were not available from Garmin; returning the current profile estimate separately.";
      }
      return response;
    },
  },
  {
    name: "get_respiration_trend",
    desc: "Get overnight respiration rate trend over a date range. Elevated resting respiration versus personal baseline is an early warning for overreaching, illness, or poor recovery; use alongside HRV trend. Recommended range: 7-21 days. Maximum: 30 days (one API call per day, kept within Cloudflare Workers' ~50 subrequest limit).",
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const { start_date, end_date } = args;
      assertSpan(start_date, end_date, 30);
      const days = eachDate(start_date, end_date);
      const results = await Promise.all(
        days.map((d) => ctx.api(`/wellness-service/wellness/daily/respiration/${d}`).catch(() => null))
      );
      const trend: Record<string, any>[] = [];
      for (let i = 0; i < days.length; i++) {
        const data = asDict(results[i]);
        if (Object.keys(data).length === 0) continue;
        const entry: Record<string, any> = { date: days[i] };
        if (data.avgWakingRespirationValue != null) entry.avg_waking_breaths_per_min = r1(data.avgWakingRespirationValue);
        if (data.avgSleepRespirationValue != null) entry.avg_sleep_breaths_per_min = r1(data.avgSleepRespirationValue);
        if (data.highestRespirationValue != null) entry.highest_breaths_per_min = r1(data.highestRespirationValue);
        if (data.lowestRespirationValue != null) entry.lowest_breaths_per_min = r1(data.lowestRespirationValue);
        if (Object.keys(entry).length > 1) trend.push(entry);
      }
      if (!trend.length) return { message: `No respiration data found between ${start_date} and ${end_date}.` };
      const sleepValues = trend
        .map((e) => e.avg_sleep_breaths_per_min)
        .filter((v): v is number => v != null);
      return {
        start_date,
        end_date,
        days_with_data: trend.length,
        period_avg_sleep_breaths_per_min: sleepValues.length
          ? r1(sleepValues.reduce((a, b) => a + b, 0) / sleepValues.length)
          : null,
        trend,
      };
    },
  },
];
