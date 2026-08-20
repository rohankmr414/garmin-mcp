import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { dateStr, stripNulls } from "../toolkit";

type Dict = Record<string, any>;

const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);

// python repr()-style rendering for error messages ported from the Python module
const rep = (v: unknown): string => (typeof v === "string" ? `'${v}'` : JSON.stringify(v));

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: string, field = "date"): void {
  if (!DATE_RE.test(value)) throw new Error(`Invalid ${field} '${value}': expected YYYY-MM-DD`);
}

const MAX_BATCH = 40;
function capBatch(n: number): void {
  if (n > MAX_BATCH) throw new Error(`Too many items: max ${MAX_BATCH} per call`);
}

// ============================================================================
// Canonical Garmin id<->key maps
// ============================================================================

const END_CONDITION_TYPE_IDS: Record<string, number> = {
  "lap.button": 1,
  time: 2,
  distance: 3,
  calories: 4,
  power: 5,
  "heart.rate": 6,
  iterations: 7,
  "fixed.rest": 8,
  "fixed.repetition": 9,
  reps: 10,
  "training.peaks.tss": 11,
};
const END_CONDITION_TYPE_KEYS: Record<number, string> = {};
for (const [key, id] of Object.entries(END_CONDITION_TYPE_IDS)) END_CONDITION_TYPE_KEYS[id] = key;

// Partial mapping verified against Garmin-created workouts; unknown ids pass through.
// ID 6 is sport-dependent: running/swim "pace.zone", cycling "power.between".
const KNOWN_TARGET_TYPE_IDS: Record<number, string[]> = {
  1: ["no.target"],
  2: ["power.zone"],
  4: ["heart.rate.zone"],
  6: ["pace.zone", "power.between"],
};
const KNOWN_TARGET_TYPE_KEYS: Record<string, number> = {};
for (const [id, keys] of Object.entries(KNOWN_TARGET_TYPE_IDS)) {
  for (const key of keys) KNOWN_TARGET_TYPE_KEYS[key] = Number(id);
}

const TARGET_FIELD_LAYOUTS: Record<string, { bounds: [string, string]; zone: string }> = {
  targetType: { bounds: ["targetValueOne", "targetValueTwo"], zone: "zoneNumber" },
  secondaryTargetType: {
    bounds: ["secondaryTargetValueOne", "secondaryTargetValueTwo"],
    zone: "secondaryZoneNumber",
  },
};

// ============================================================================
// Workout JSON guard chain (normalize + validate before upload)
// ============================================================================

function collectStepTree(step: Dict, path: string, out: Array<[Dict, string]>): void {
  out.push([step, path]);
  (step.workoutSteps ?? []).forEach((nested: Dict, i: number) =>
    collectStepTree(nested, `${path}.workoutSteps[${i}]`, out)
  );
}

function allWorkoutSteps(workoutData: Dict): Array<[Dict, string]> {
  const out: Array<[Dict, string]> = [];
  (workoutData.workoutSegments ?? []).forEach((segment: Dict, si: number) => {
    (segment.workoutSteps ?? []).forEach((step: Dict, sti: number) =>
      collectStepTree(step, `workoutSegments[${si}].workoutSteps[${sti}]`, out)
    );
  });
  return out;
}

// Reject conflicting or ambiguous target fields before any repair.
function validateNestedTargetFields(step: Dict, path: string): void {
  for (const [targetField, layout] of Object.entries(TARGET_FIELD_LAYOUTS)) {
    const targetType = step[targetField];
    if (!isDict(targetType)) continue;

    const fields = [...layout.bounds, layout.zone];
    for (const field of fields) {
      const nestedValue = targetType[field];
      if (nestedValue != null && step[field] != null && step[field] !== nestedValue) {
        throw new Error(
          `${path}.${field}=${rep(step[field])} conflicts with ` +
            `${path}.${targetField}.${field}=${rep(nestedValue)}; ` +
            `keep only the step-level ${field}`
        );
      }
    }

    const zoneField = layout.zone;
    let zoneValue = step[zoneField];
    if (zoneValue == null) zoneValue = targetType[zoneField];

    const boundValues: Array<[string, unknown]> = [];
    for (const field of layout.bounds) {
      let value = step[field];
      if (value == null) value = targetType[field];
      if (value != null) boundValues.push([field, value]);
    }

    if (zoneValue != null && boundValues.length) {
      const bounds = boundValues.map(([field, value]) => `${field}=${rep(value)}`).join(", ");
      throw new Error(
        `${path} mixes ${zoneField}=${rep(zoneValue)} with custom ` +
          `range fields (${bounds}); use either a named zone or a custom range`
      );
    }
  }
}

// Move target fields to the step level, where Garmin reads them.
function moveNestedTargetFields(step: Dict): void {
  for (const [targetField, layout] of Object.entries(TARGET_FIELD_LAYOUTS)) {
    const targetType = step[targetField];
    if (!isDict(targetType)) continue;

    const fields = [...layout.bounds, layout.zone];
    for (const field of fields) {
      if (!(field in targetType)) continue;
      const value = targetType[field];
      delete targetType[field];
      if (value != null && step[field] == null) step[field] = value;
    }
  }
}

// HR-zone index mistakenly in targetValueOne (1-5) -> zoneNumber; custom bpm ranges untouched.
function fixHrZoneStep(step: Dict): void {
  const targetType = step.targetType;
  const targetKey = isDict(targetType) ? (targetType.workoutTargetTypeKey ?? "") : "";

  if (targetKey === "heart.rate.zone" && !("zoneNumber" in step)) {
    const zone = step.targetValueOne;
    if (typeof zone === "number" && zone >= 1 && zone <= 5) {
      step.zoneNumber = Math.trunc(zone);
      delete step.targetValueOne;
      delete step.targetValueTwo;
    }
  }

  for (const nested of step.workoutSteps ?? []) fixHrZoneStep(nested);
}

// Missing conditionTypeId corrupts RepeatGroupDTO server-side; add id 7 and backfill iterations.
function fixRepeatGroupStep(step: Dict): void {
  if (step.type !== "RepeatGroupDTO") {
    for (const nested of step.workoutSteps ?? []) fixRepeatGroupStep(nested);
    return;
  }

  const endCondition = step.endCondition;
  if (isDict(endCondition)) {
    if (endCondition.conditionTypeKey === "iterations" && !("conditionTypeId" in endCondition)) {
      endCondition.conditionTypeId = 7;
    }
  }

  if (!("numberOfIterations" in step)) {
    const value = step.endConditionValue;
    if (value != null) step.numberOfIterations = Math.trunc(Number(value));
  }

  for (const nested of step.workoutSteps ?? []) fixRepeatGroupStep(nested);
}

// Repair recoverable step-shape mistakes before validation and upload.
function normalizeWorkoutSteps(workoutData: Dict): void {
  const steps = allWorkoutSteps(workoutData);

  // Preflight the complete workout so a later conflict cannot leave an earlier step half-repaired.
  for (const [step, path] of steps) validateNestedTargetFields(step, path);
  for (const [step] of steps) moveNestedTargetFields(step);

  // These helpers recurse, so invoke them only for top-level steps.
  for (const segment of workoutData.workoutSegments ?? []) {
    for (const step of segment.workoutSteps ?? []) {
      fixHrZoneStep(step);
      fixRepeatGroupStep(step);
    }
  }
}

// Reject endCondition id/key pairs Garmin would silently reinterpret.
function validateEndConditionStep(step: Dict, path: string): void {
  const endCondition = step.endCondition;
  if (isDict(endCondition)) {
    const conditionKey = endCondition.conditionTypeKey;
    const conditionId = endCondition.conditionTypeId;

    const expectedId = conditionKey != null ? END_CONDITION_TYPE_IDS[conditionKey] : undefined;
    const expectedKey = conditionId != null ? END_CONDITION_TYPE_KEYS[conditionId] : undefined;

    if (expectedId !== undefined) {
      if (conditionId == null) {
        throw new Error(
          `${path}.endCondition conditionTypeKey '${conditionKey}' ` +
            `requires conditionTypeId ${expectedId}`
        );
      }
      if (conditionId !== expectedId) {
        throw new Error(
          `${path}.endCondition conditionTypeKey '${conditionKey}' ` +
            `requires conditionTypeId ${expectedId}, got ${conditionId} ` +
            `(${expectedKey ?? "unknown"})`
        );
      }
    } else if (expectedKey !== undefined && conditionKey != null) {
      throw new Error(
        `${path}.endCondition conditionTypeId ${conditionId} ` +
          `requires conditionTypeKey '${expectedKey}', got '${conditionKey}'`
      );
    }
  }

  (step.workoutSteps ?? []).forEach((nested: Dict, i: number) =>
    validateEndConditionStep(nested, `${path}.workoutSteps[${i}]`)
  );
}

function validateEndConditionSteps(workoutData: Dict): void {
  (workoutData.workoutSegments ?? []).forEach((segment: Dict, si: number) => {
    (segment.workoutSteps ?? []).forEach((step: Dict, sti: number) =>
      validateEndConditionStep(step, `workoutSegments[${si}].workoutSteps[${sti}]`)
    );
  });
}

// Reject a target type id/key pair Garmin would silently reinterpret; unknown ids pass through.
function validateTargetTypeBlock(step: Dict, path: string, targetField: string): void {
  const targetType = step[targetField];
  if (!isDict(targetType)) return;

  const targetKey = targetType.workoutTargetTypeKey;
  let targetId: number | undefined;

  if (targetType.workoutTargetTypeId != null) {
    const n = Number(targetType.workoutTargetTypeId);
    if (!Number.isFinite(n)) {
      throw new Error(`${path}.${targetField}.workoutTargetTypeId must be numeric`);
    }
    targetId = Math.trunc(n);
  }

  const validKeys = targetId != null ? KNOWN_TARGET_TYPE_IDS[targetId] : undefined;
  if (validKeys !== undefined && targetKey != null && !validKeys.includes(targetKey)) {
    if (validKeys.length === 1) {
      throw new Error(
        `${path}.${targetField} mismatch: workoutTargetTypeId ${targetId} is ` +
          `${rep(validKeys[0])}, not ${rep(targetKey)}`
      );
    }
    const validList = validKeys.map(rep).sort().join(", ");
    throw new Error(
      `${path}.${targetField} mismatch: workoutTargetTypeId ${targetId} is ` +
        `one of (${validList}), not ${rep(targetKey)}`
    );
  }

  const expectedId = targetKey != null ? KNOWN_TARGET_TYPE_KEYS[targetKey] : undefined;
  if (expectedId !== undefined && targetId != null && targetId !== expectedId) {
    throw new Error(
      `${path}.${targetField} mismatch: workoutTargetTypeKey ${rep(targetKey)} ` +
        `requires workoutTargetTypeId ${expectedId}, not ${targetId}`
    );
  }
}

function validateTargetTypeStep(step: Dict, path: string): void {
  validateTargetTypeBlock(step, path, "targetType");
  validateTargetTypeBlock(step, path, "secondaryTargetType");
  (step.workoutSteps ?? []).forEach((nested: Dict, i: number) =>
    validateTargetTypeStep(nested, `${path}.workoutSteps[${i}]`)
  );
}

function validateTargetTypeSteps(workoutData: Dict): void {
  (workoutData.workoutSegments ?? []).forEach((segment: Dict, si: number) => {
    (segment.workoutSteps ?? []).forEach((step: Dict, sti: number) =>
      validateTargetTypeStep(step, `workoutSegments[${si}].workoutSteps[${sti}]`)
    );
  });
}

// ============================================================================
// Response curation
// ============================================================================

function curateWorkoutSummary(workout: Dict): Dict {
  const summary: Dict = {
    id: workout.workoutId,
    name: workout.workoutName,
    sport: workout.sportType?.sportTypeKey,
    provider: workout.workoutProvider,
    created_date: workout.createdDate,
    updated_date: workout.updatedDate,
  };
  if (workout.description) summary.description = workout.description;
  if (workout.estimatedDuration) summary.estimated_duration_seconds = workout.estimatedDuration;
  if (workout.estimatedDistance) summary.estimated_distance_meters = workout.estimatedDistance;
  return stripNulls(summary);
}

function curateStepTarget(
  curated: Dict,
  step: Dict,
  targetField: string,
  valueOneField: string,
  valueTwoField: string,
  zoneField: string,
  prefix = ""
): void {
  const targetType = isDict(step[targetField]) ? step[targetField] : {};
  const targetKey = targetType.workoutTargetTypeKey;
  if (!targetKey || targetKey === "no.target") return;

  curated[`${prefix}target_type`] = targetKey;
  if (step[valueOneField] != null) curated[`${prefix}target_value_low`] = step[valueOneField];
  if (step[valueTwoField] != null) curated[`${prefix}target_value_high`] = step[valueTwoField];
  if (step[zoneField] != null) curated[`${prefix}target_zone`] = step[zoneField];
}

function curateWorkoutStep(step: Dict): Dict {
  const stepType = step.stepType ?? {};
  const endCondition = step.endCondition ?? {};

  const curated: Dict = {
    order: step.stepOrder,
    type: stepType.stepTypeKey, // warmup, interval, cooldown, rest, recover
  };

  if (step.description) curated.description = step.description;

  if (endCondition.conditionTypeKey) curated.end_condition = endCondition.conditionTypeKey;
  // Value meaning depends on condition type (seconds for time, meters for distance)
  if (step.endConditionValue) curated.end_condition_value = step.endConditionValue;

  curateStepTarget(curated, step, "targetType", "targetValueOne", "targetValueTwo", "zoneNumber");
  // Swim workouts often store pace prescriptions as secondary targets.
  curateStepTarget(
    curated,
    step,
    "secondaryTargetType",
    "secondaryTargetValueOne",
    "secondaryTargetValueTwo",
    "secondaryZoneNumber",
    "secondary_"
  );

  const strokeType = step.strokeType;
  if (isDict(strokeType) && strokeType.strokeTypeKey) curated.stroke_type = strokeType.strokeTypeKey;
  const equipmentType = step.equipmentType;
  if (isDict(equipmentType) && equipmentType.equipmentTypeKey) {
    curated.equipment_type = equipmentType.equipmentTypeKey;
  }
  const drillType = step.drillType;
  if (isDict(drillType) && drillType.drillTypeKey) curated.drill_type = drillType.drillTypeKey;

  if (step.category) curated.category = step.category;
  if (step.exerciseName) curated.exercise_name = step.exerciseName;
  if (step.weightValue != null) {
    curated.weight_value = step.weightValue;
    const weightUnit = step.weightUnit;
    if (isDict(weightUnit) && weightUnit.unitKey) curated.weight_unit = weightUnit.unitKey;
  }

  if (step.type === "RepeatGroupDTO") {
    curated.repeat_count = step.numberOfIterations;
    const nestedSteps = step.workoutSteps ?? [];
    if (nestedSteps.length) {
      curated.steps = nestedSteps.map((s: Dict) => curateWorkoutStep(s));
      curated.step_count = nestedSteps.length;
    }
  }

  return stripNulls(curated);
}

function curateWorkoutSegment(segment: Dict): Dict {
  const curated: Dict = {
    order: segment.segmentOrder,
    sport: segment.sportType?.sportTypeKey,
  };
  if (segment.estimatedDurationInSecs) {
    curated.estimated_duration_seconds = segment.estimatedDurationInSecs;
  }
  if (segment.estimatedDistanceInMeters) {
    curated.estimated_distance_meters = segment.estimatedDistanceInMeters;
  }
  const steps = segment.workoutSteps ?? [];
  if (steps.length) {
    curated.steps = steps.map((s: Dict) => curateWorkoutStep(s));
    curated.step_count = steps.length;
  }
  return stripNulls(curated);
}

// Handles both regular workouts and fbt-adaptive training-plan workouts (different field names).
function curateWorkoutDetails(workout: Dict): Dict {
  const sportType = workout.sportType ?? {};

  const details: Dict = {
    id: workout.workoutId,
    uuid: workout.workoutUuid,
    name: workout.workoutName,
    sport: sportType.sportTypeKey,
    provider: workout.workoutProvider,
    created_date: workout.createdDate,
    updated_date: workout.updatedDate,
  };

  if (workout.description) details.description = workout.description;

  const duration = workout.estimatedDuration || workout.estimatedDurationInSecs;
  if (duration) details.estimated_duration_seconds = duration;
  const distance = workout.estimatedDistance || workout.estimatedDistanceInMeters;
  if (distance) details.estimated_distance_meters = distance;

  if (workout.avgTrainingSpeed) details.avg_training_speed_mps = workout.avgTrainingSpeed;
  if (workout.workoutPhrase) details.workout_type = workout.workoutPhrase;
  if (workout.trainingEffectLabel) details.training_effect_label = workout.trainingEffectLabel;
  if (workout.estimatedTrainingEffect) {
    details.estimated_training_effect = workout.estimatedTrainingEffect;
  }

  const segments = workout.workoutSegments ?? [];
  if (segments.length) {
    details.segments = segments.map((seg: Dict) => curateWorkoutSegment(seg));
    details.segment_count = segments.length;
  }

  return stripNulls(details);
}

function curateScheduledWorkout(scheduled: Dict): Dict {
  // Completed is determined by presence of associatedActivityId
  const isCompleted = scheduled.associatedActivityId != null;

  const summary: Dict = {
    date: scheduled.scheduleDate,
    // Calendar-entry id (distinct from workout_id); pass to unschedule_workout.
    scheduled_workout_id: scheduled.scheduledWorkoutId,
    workout_uuid: scheduled.workoutUuid,
    workout_id: scheduled.workoutId,
    training_plan_id: scheduled.trainingPlanId,
    fbt_adaptive_plan_id: scheduled.fbtAdaptivePlanId,
    tp_type: scheduled.tpType,
    name: scheduled.workoutName,
    sport: scheduled.workoutType,
    completed: isCompleted,
  };

  if (scheduled.tpPlanName) summary.training_plan = scheduled.tpPlanName;
  if (scheduled.workoutPhrase) summary.workout_type = scheduled.workoutPhrase;
  if (scheduled.isRestDay) summary.is_rest_day = true;
  if (scheduled.race) summary.is_race_day = true;
  if (scheduled.estimatedDurationInSecs) {
    summary.estimated_duration_seconds = scheduled.estimatedDurationInSecs;
  }
  if (scheduled.estimatedDistanceInMeters) {
    summary.estimated_distance_meters = scheduled.estimatedDistanceInMeters;
  }
  if (isCompleted) summary.activity_id = scheduled.associatedActivityId;

  return stripNulls(summary);
}

// ============================================================================
// API helpers
// ============================================================================

const gql = (ctx: Ctx, query: string) =>
  ctx.api("/graphql-gateway/graphql", { method: "POST", body: { query } });

const postWorkout = (ctx: Ctx, workoutData: Dict) =>
  ctx.api("/workout-service/workout", { method: "POST", body: workoutData });

async function uploadWithGuards(ctx: Ctx, workoutData: Dict): Promise<unknown> {
  normalizeWorkoutSteps(workoutData);
  validateEndConditionSteps(workoutData);
  validateTargetTypeSteps(workoutData);
  return postWorkout(ctx, workoutData);
}

function curateUploadResult(result: unknown): unknown {
  if (isDict(result)) {
    return stripNulls({
      status: "success",
      workout_id: result.workoutId,
      name: result.workoutName,
      message: "Workout uploaded successfully",
    });
  }
  return result;
}

const scheduleWorkoutPost = (ctx: Ctx, workoutId: number, calendarDate: string) =>
  ctx.api(`/workout-service/schedule/${workoutId}`, {
    method: "POST",
    body: { date: calendarDate },
  });

// Garmin's schedule endpoint is not idempotent: a second POST duplicates the calendar
// entry. Pre-check via GraphQL; a failing pre-check falls through to the POST path.
async function isAlreadyScheduled(
  ctx: Ctx,
  workoutId: number,
  calendarDate: string
): Promise<boolean> {
  try {
    validateDate(calendarDate, "calendar_date");
    const result = (await gql(
      ctx,
      `query{workoutScheduleSummariesScalar(startDate:"${calendarDate}", endDate:"${calendarDate}")}`
    )) as Dict;
    const existing: Dict[] = result?.data?.workoutScheduleSummariesScalar ?? [];
    for (const entry of existing) {
      if (entry?.workoutId === workoutId && entry?.scheduleDate === calendarDate) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function getGarminCoachWorkouts(ctx: Ctx, calendarDate: string): Promise<unknown> {
  validateDate(calendarDate, "calendar_date");
  const result = (await gql(
    ctx,
    `query{trainingPlanScalar(calendarDate:"${calendarDate}", lang:"en-US", firstDayOfWeek:"monday")}`
  )) as Dict;

  if (!isDict(result) || !isDict(result.data)) {
    return "No training plan data found or error querying data.";
  }
  const planData = result.data.trainingPlanScalar ?? {};
  if (!isDict(planData)) return "No training plan data found or error querying data.";

  const trainingPlans = planData.trainingPlanWorkoutScheduleDTOS ?? [];
  if (!Array.isArray(trainingPlans) || !trainingPlans.length) {
    return `No training plan workouts scheduled for ${calendarDate}.`;
  }

  const allWorkouts: Dict[] = [];
  const planNames: string[] = [];
  const plans: Dict[] = [];
  let validPlanCount = 0;

  for (const plan of trainingPlans) {
    if (!isDict(plan)) continue;
    validPlanCount += 1;

    const planName = plan.planName;
    if (planName && !planNames.includes(planName)) planNames.push(planName);

    const planDetails = isDict(plan.trainingPlanDetailsDTO) ? plan.trainingPlanDetailsDTO : {};
    const planSummary = stripNulls({
      name: planName,
      training_plan_id: plan.trainingPlanId,
      classification: plan.trainingPlanClassification,
      training_type: planDetails.trainingType,
    }) as Dict;
    if (Object.keys(planSummary).length) plans.push(planSummary);

    const workoutSummaries = plan.workoutScheduleSummaries ?? [];
    if (!Array.isArray(workoutSummaries)) continue;
    for (const workout of workoutSummaries) {
      if (isDict(workout)) allWorkouts.push(curateScheduledWorkout(workout));
    }
  }

  if (validPlanCount === 0) return `No training plan workouts scheduled for ${calendarDate}.`;

  return stripNulls({
    date: calendarDate,
    training_plans: planNames.length ? planNames : null,
    plans: plans.length ? plans : null,
    count: allWorkouts.length,
    workouts: allWorkouts,
  });
}

// ============================================================================
// Workout JSON builders
// ============================================================================

const HR_ZONE_MAP: Record<string, number> = { Z1: 1, Z2: 2, Z3: 3, Z4: 4, Z5: 5 };

function zoneNumber(zone: string): number {
  const zoneUpper = zone.trim().toUpperCase();
  if (zoneUpper in HR_ZONE_MAP) return HR_ZONE_MAP[zoneUpper];
  const z = Number(zoneUpper);
  if (Number.isInteger(z) && z >= 1 && z <= 5) return z;
  throw new Error(`Invalid hr_zone '${zone}'. Use Z1-Z5 or 1-5.`);
}

// Custom bpm range and named zone are mutually exclusive; a range wins over hr_zone.
function hrTarget(
  hrZone: string,
  hrMin: number | undefined,
  hrMax: number | undefined
): { fields: Dict; desc: string } {
  if (hrMin != null || hrMax != null) {
    if (hrMin == null || hrMax == null) {
      throw new Error("hr_min and hr_max must both be provided together.");
    }
    if (hrMin >= hrMax) {
      throw new Error(`hr_min (${hrMin}) must be less than hr_max (${hrMax}).`);
    }
    return { fields: { targetValueOne: hrMin, targetValueTwo: hrMax }, desc: `${hrMin}-${hrMax}bpm` };
  }
  const zone = zoneNumber(hrZone);
  return { fields: { zoneNumber: zone }, desc: `Z${zone}` };
}

function buildRunJson(
  name: string,
  runSeconds: number,
  warmupMin: number,
  cooldownMin: number,
  hrZone = "Z3",
  hrMin?: number,
  hrMax?: number
): Dict {
  const { fields: hrTargetFields, desc: hrDesc } = hrTarget(hrZone, hrMin, hrMax);
  const runDisplay = runSeconds % 60 === 0 ? `${Math.floor(runSeconds / 60)}m` : `${runSeconds}s`;
  return {
    workoutName: name,
    description: `${warmupMin}m warmup + ${runDisplay} run ${hrDesc} + ${cooldownMin}m cooldown`,
    sportType: { sportTypeId: 1, sportTypeKey: "running" },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 1, sportTypeKey: "running" },
        workoutSteps: [
          {
            type: "ExecutableStepDTO",
            stepOrder: 1,
            stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
            description: `Warmup ${warmupMin} min`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: warmupMin * 60,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
          {
            type: "ExecutableStepDTO",
            stepOrder: 2,
            stepType: { stepTypeId: 3, stepTypeKey: "interval" },
            description: `Run ${runSeconds}s ${hrDesc}`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: runSeconds,
            targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
            ...hrTargetFields,
          },
          {
            type: "ExecutableStepDTO",
            stepOrder: 3,
            stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
            description: `Cooldown ${cooldownMin} min`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: cooldownMin * 60,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
        ],
      },
    ],
  };
}

function buildWalkRunJson(
  name: string,
  runSeconds: number,
  walkSeconds: number,
  repeats: number,
  warmupMin: number,
  cooldownMin: number,
  hrZone = "Z3"
): Dict {
  const zone = zoneNumber(hrZone);
  return {
    workoutName: name,
    description:
      `${warmupMin}m warmup + ${repeats}x(${runSeconds}s run / ${walkSeconds}s walk) Z${zone} + ` +
      `${cooldownMin}m cooldown`,
    sportType: { sportTypeId: 1, sportTypeKey: "running" },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 1, sportTypeKey: "running" },
        workoutSteps: [
          {
            type: "ExecutableStepDTO",
            stepOrder: 1,
            stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
            description: `Warmup ${warmupMin} min`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: warmupMin * 60,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
          {
            type: "RepeatGroupDTO",
            stepOrder: 2,
            numberOfIterations: repeats,
            workoutSteps: [
              {
                type: "ExecutableStepDTO",
                stepOrder: 1,
                stepType: { stepTypeId: 3, stepTypeKey: "interval" },
                description: `Run ${runSeconds}s Z${zone}`,
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: runSeconds,
                targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
                zoneNumber: zone,
              },
              {
                type: "ExecutableStepDTO",
                stepOrder: 2,
                stepType: { stepTypeId: 4, stepTypeKey: "recovery" },
                description: `Walk ${walkSeconds}s Z${zone}`,
                endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
                endConditionValue: walkSeconds,
                targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
                zoneNumber: zone,
              },
            ],
          },
          {
            type: "ExecutableStepDTO",
            stepOrder: 3,
            stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
            description: `Cooldown ${cooldownMin} min`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: cooldownMin * 60,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
        ],
      },
    ],
  };
}

function buildZ2WalkJson(name: string, durationMin: number, hrMin: number, hrMax: number): Dict {
  return {
    workoutName: name,
    description: `Walk ${durationMin} min at Z2 (${hrMin}-${hrMax} bpm)`,
    sportType: { sportTypeId: 12, sportTypeKey: "walking" },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 12, sportTypeKey: "walking" },
        workoutSteps: [
          {
            type: "ExecutableStepDTO",
            stepOrder: 1,
            stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
            description: "Warmup 5 min",
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: 300,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
          {
            type: "ExecutableStepDTO",
            stepOrder: 2,
            stepType: { stepTypeId: 3, stepTypeKey: "interval" },
            description: `Walk ${durationMin} min Z2`,
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: durationMin * 60,
            targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
            zoneNumber: 2,
          },
          {
            type: "ExecutableStepDTO",
            stepOrder: 3,
            stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
            description: "Cooldown 5 min",
            endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
            endConditionValue: 300,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          },
        ],
      },
    ],
  };
}

function buildStrengthJson(name: string, exercises: Dict[]): Dict {
  const steps: Dict[] = [];
  let stepOrder = 1;

  exercises.forEach((ex, index) => {
    const exName = ex.name ?? "Exercise";
    const sets = Math.trunc(Number(ex.sets ?? 1));
    const reps = Math.trunc(Number(ex.reps ?? 1));
    const restSeconds = Math.trunc(Number(ex.rest_seconds ?? 60));

    const step: Dict = {
      type: "ExecutableStepDTO",
      stepOrder,
      stepType: { stepTypeId: 3, stepTypeKey: "interval" },
      description: `${exName}: ${sets} sets x ${reps} reps`,
      endCondition: { conditionTypeId: 10, conditionTypeKey: "reps" },
      endConditionValue: reps,
      targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
      exerciseName: exName,
    };

    // Garmin rejects categories outside its enum; an absent category is accepted,
    // so only emit one when the caller supplies it, uppercased.
    const category = ex.category;
    if (category != null) {
      if (typeof category !== "string" || !category.trim()) {
        throw new Error(`category for exercise ${rep(exName)} must be a non-empty string`);
      }
      step.category = category.trim().toUpperCase();
    }

    steps.push(step);
    stepOrder += 1;

    // Rest step (skip after last exercise)
    if (restSeconds > 0 && index !== exercises.length - 1) {
      steps.push({
        type: "ExecutableStepDTO",
        stepOrder,
        stepType: { stepTypeId: 4, stepTypeKey: "recovery" },
        description: `Rest ${restSeconds}s`,
        endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
        endConditionValue: restSeconds,
        targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
      });
      stepOrder += 1;
    }
  });

  return {
    workoutName: name,
    description: `Strength: ${exercises.length} exercises`,
    sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
        workoutSteps: steps,
      },
    ],
  };
}

// ============================================================================
// Tools
// ============================================================================

export const tools: ToolDef[] = [
  {
    name: "get_workouts",
    desc: `Get all workouts with curated summary list

Returns a count and list of workout summaries with essential metadata only.
For detailed workout information including segments, use get_workout_by_id.`,
    run: async (_args, ctx) => {
      const workouts = (await ctx.api("/workout-service/workouts", {
        params: { start: "0", limit: "100" },
      })) as Dict[];
      if (!Array.isArray(workouts) || !workouts.length) return "No workouts found.";
      return { count: workouts.length, workouts: workouts.map(curateWorkoutSummary) };
    },
  },
  {
    name: "get_workout_by_id",
    desc: `Get detailed information for a specific workout

Returns workout details including segments and step structure.

Accepts either:
- Numeric workout ID (from get_workouts, get_scheduled_workouts, or training-plan families that expose workout_id)
- Workout UUID (from adaptive Garmin Coach/training-plan workouts)

Rest-day UUIDs can resolve to a minimal record without a workout name or segments.`,
    params: {
      workout_id: z
        .union([z.number(), z.string()])
        .describe("Workout ID (numeric) or UUID (for training plan workouts)"),
    },
    run: async (args, ctx) => {
      const workoutIdStr = String(args.workout_id);
      // UUIDs (contain dashes) live on the fbt-adaptive endpoint
      const path = workoutIdStr.includes("-")
        ? `/workout-service/fbt-adaptive/${workoutIdStr}`
        : `/workout-service/workout/${workoutIdStr}`;
      const workout = (await ctx.api(path)) as Dict;
      if (!workout) return `No workout found with ID ${workoutIdStr}.`;
      return curateWorkoutDetails(workout);
    },
  },
  {
    name: "download_workout",
    desc: `Download a workout as a FIT file

Downloads the workout in FIT format. The binary data cannot be returned
directly through the MCP interface, but this confirms the workout is available.`,
    params: {
      workout_id: z.number().describe("ID of the workout to download"),
    },
    run: async (args, ctx) => {
      const res = (await ctx.api(`/workout-service/workout/FIT/${args.workout_id}`, {
        binary: true,
      })) as { base64: string };
      const b64 = res.base64 ?? "";
      if (!b64) return `No workout data found for workout with ID ${args.workout_id}.`;
      let sizeBytes = Math.floor((b64.length * 3) / 4);
      if (b64.endsWith("==")) sizeBytes -= 2;
      else if (b64.endsWith("=")) sizeBytes -= 1;
      return {
        workout_id: args.workout_id,
        format: "FIT",
        size_bytes: sizeBytes,
        message: "Workout data is available in FIT format. Use Garmin Connect API to save to file.",
      };
    },
  },
  {
    name: "upload_workout",
    desc: `Upload a workout from JSON data

Creates a new workout in Garmin Connect from structured workout data.

IMPORTANT: Step types must use Garmin's DTO format:
- Use "ExecutableStepDTO" for regular steps (warmup, interval, cooldown, recovery)
- Use "RepeatGroupDTO" for repeat/interval groups with numberOfIterations.
  Always include endCondition with conditionTypeId 7 and conditionTypeKey
  "iterations"; omitting conditionTypeId causes the API to silently corrupt
  the repeat count.

IMPORTANT: Heart rate targets come in two forms:
- Named zone (e.g. Zone 2): set targetType to "heart.rate.zone" and use "zoneNumber" (1-5).
  Do NOT put the zone number in targetValueOne.
- Custom HR range (e.g. 105-143 bpm): set targetType to "heart.rate.zone" and use
  "targetValueOne" (low bpm) / "targetValueTwo" (high bpm). Do NOT set "zoneNumber".
  This matches Garmin Connect's "Custom" heart rate target.
For non-HR targets (pace, power, cadence), use targetValueOne/targetValueTwo directly.
Target values are fields on the workout step, alongside targetType; do not put
targetValueOne, targetValueTwo, or zoneNumber inside the targetType object.
Use either zoneNumber or targetValueOne/targetValueTwo, not both. Garmin silently
discards a custom range when a named zone is also present.

Note: a safety check converts targetValueOne 1-5 to zoneNumber when zoneNumber is missing,
to catch the common mistake of putting a zone index in targetValueOne. Typical bpm values
(e.g. 105, 143) are not affected.

IMPORTANT: Target type IDs and keys must match Garmin's canonical mapping.
Garmin treats workoutTargetTypeId as authoritative, so mismatches are rejected
before upload. Known mappings:
- workoutTargetTypeId 1  -> "no.target"
- workoutTargetTypeId 2  -> "power.zone"  (cycling power zone 1-7, use zoneNumber)
- workoutTargetTypeId 4  -> "heart.rate.zone"
- workoutTargetTypeId 6  -> "pace.zone" (running/swim) OR "power.between" (cycling)

IMPORTANT: For cycling power targets use the correct target type:
- Power zone (zone 1-7 based on FTP %): use workoutTargetTypeId 2, key "power.zone",
  and "zoneNumber" (1-7).
- Absolute watt range (e.g. 200-250 W): use workoutTargetTypeId 6, key "power.between",
  and "targetValueOne" (low watts) / "targetValueTwo" (high watts).
Using workoutTargetTypeId 2 with key "power.between" is a silent Garmin bug: the
workout uploads but Garmin stores it as "power.zone" and the intent is lost.

Use {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone"} with
targetValueOne/targetValueTwo for custom heart-rate ranges.

IMPORTANT: Sport type IDs for workouts (different from activity API!):
- 1 = running, 2 = cycling, 5 = strength_training, 6 = cardio, 11 = walking

IMPORTANT: End condition IDs and keys must match Garmin's canonical mapping.
Garmin treats conditionTypeId as authoritative, so mismatches such as
{"conditionTypeId": 4, "conditionTypeKey": "heart.rate"} are rejected before
upload because Garmin would interpret them as "calories". Use
{"conditionTypeId": 6, "conditionTypeKey": "heart.rate"} for heart-rate
end conditions.

**Available Templates:**
Instead of building workout JSON from scratch, you can use these MCP resources as starting points:
- workout://templates/simple-run - Basic warmup/run/cooldown structure
- workout://templates/interval-running - Interval training with repeat groups
- workout://templates/tempo-run - Tempo run with heart rate zone targets
- workout://templates/strength-circuit - Strength training with exercises, reps, rest
- workout://reference/structure - Complete JSON structure reference with all fields

Access these resources using your MCP client's resource reading capability, modify the template
as needed, and pass the resulting JSON as the workout_data parameter.

**Strength training workouts** require these additional fields on each exercise step:
- "category": exercise category (e.g. "BENCH_PRESS", "PULL_UP", "CURL", "SHOULDER_PRESS",
  "ROW", "SQUAT", "DEADLIFT", "TRICEPS_EXTENSION", "PLANK", "LUNGE", "CARDIO")
- "exerciseName": specific exercise (e.g. "BARBELL_BENCH_PRESS", "PULL_UP",
  "DUMBBELL_BICEPS_CURL", "DUMBBELL_SHOULDER_PRESS", "BENT_OVER_ROW_WITH_DUMBELL",
  "BODY_WEIGHT_DIP", "BARBELL_SQUAT", "BARBELL_DEADLIFT")
- "weightValue" (optional): weight as number (e.g. 24.0)
- "weightUnit" (optional): {"unitId": 8, "unitKey": "kilogram", "factor": 1000.0}
Use endCondition reps (conditionTypeId: 10) for exercises, rest (stepTypeId: 5) between sets.

Example running workout with HR zone target:
{
    "workoutName": "My Workout",
    "sportType": {"sportTypeId": 1, "sportTypeKey": "running"},
    "workoutSegments": [{
        "segmentOrder": 1,
        "sportType": {"sportTypeId": 1, "sportTypeKey": "running"},
        "workoutSteps": [{
            "type": "ExecutableStepDTO",
            "stepOrder": 1,
            "stepType": {"stepTypeId": 3, "stepTypeKey": "interval"},
            "endCondition": {"conditionTypeId": 2, "conditionTypeKey": "time"},
            "endConditionValue": 1200.0,
            "targetType": {"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone"},
            "zoneNumber": 3
        }]
    }]
}`,
    params: {
      workout_data: z
        .record(z.any())
        .describe(
          "Dictionary containing workout structure (workoutName, sportType, workoutSegments with workoutSteps, etc.)"
        ),
    },
    run: async (args, ctx) => {
      const result = await uploadWithGuards(ctx, args.workout_data as Dict);
      return curateUploadResult(result);
    },
  },
  {
    name: "upload_workouts",
    desc: `Upload multiple workouts from JSON data in a single call

Creates multiple new workouts in Garmin Connect. Each item in the list
uses the same structure as upload_workout.

IMPORTANT: Step types must use Garmin's DTO format:
- Use "ExecutableStepDTO" for regular steps (warmup, interval, cooldown, recovery)
- Use "RepeatGroupDTO" for repeat/interval groups with numberOfIterations.
  Always include endCondition with conditionTypeId 7 and conditionTypeKey
  "iterations"; omitting conditionTypeId causes the API to silently corrupt
  the repeat count.

IMPORTANT: For named heart rate zone targets, use "zoneNumber" (1-5), NOT targetValueOne/targetValueTwo.
For custom heart-rate ranges, use targetType {"workoutTargetTypeId": 4,
"workoutTargetTypeKey": "heart.rate.zone"} with targetValueOne/targetValueTwo.
Target values belong on the workout step, alongside targetType, not inside it.
For cycling power zone targets (zone-based), use workoutTargetTypeId 2, key "power.zone".
For cycling absolute watt range targets, use workoutTargetTypeId 6, key "power.between",
with targetValueOne (low watts) and targetValueTwo (high watts).
Target type IDs and keys must match Garmin's canonical mapping.

IMPORTANT: End condition IDs and keys must match Garmin's canonical mapping.
Garmin treats conditionTypeId as authoritative, so mismatches are rejected before upload.

Max 40 workouts per call.`,
    params: {
      workouts: z
        .array(z.record(z.any()))
        .describe(
          "List of workout dictionaries, each containing workout structure (name, sport type, segments, etc.) — same format as upload_workout"
        ),
    },
    run: async (args, ctx) => {
      const workouts = args.workouts as Dict[];
      capBatch(workouts.length);
      const results: Dict[] = [];
      for (const workoutData of workouts) {
        try {
          const result = await uploadWithGuards(ctx, workoutData);
          if (isDict(result)) {
            results.push(
              stripNulls({
                status: "success",
                workout_id: result.workoutId,
                name: result.workoutName,
                message: "Workout uploaded successfully",
              }) as Dict
            );
          } else {
            results.push({ status: "success", message: "Workout uploaded successfully" });
          }
        } catch (e) {
          results.push({
            status: "error",
            name: workoutData?.workoutName,
            message: `Error uploading workout: ${errMsg(e)}`,
          });
        }
      }
      const succeeded = results.filter((r) => r.status === "success").length;
      return { total: results.length, succeeded, failed: results.length - succeeded, results };
    },
  },
  {
    name: "delete_workout",
    desc: `Delete a workout from Garmin Connect

Permanently removes a workout from your Garmin Connect workout library.`,
    params: {
      workout_id: z.number().describe("ID of the workout to delete (get IDs from get_workouts)"),
    },
    run: async (args, ctx) => {
      try {
        await ctx.api(`/workout-service/workout/${args.workout_id}`, { method: "DELETE" });
        return {
          status: "success",
          workout_id: args.workout_id,
          message: `Workout ${args.workout_id} deleted successfully`,
        };
      } catch (e) {
        return {
          status: "failed",
          workout_id: args.workout_id,
          message: `Failed to delete workout: ${errMsg(e)}`,
        };
      }
    },
  },
  {
    name: "delete_workouts",
    desc: `Delete multiple workouts from Garmin Connect in a single call

Permanently removes multiple workouts from your Garmin Connect workout library.
Max 40 workout IDs per call.`,
    params: {
      workout_ids: z
        .array(z.number())
        .describe("List of workout IDs to delete (get IDs from get_workouts)"),
    },
    run: async (args, ctx) => {
      const ids = args.workout_ids as number[];
      capBatch(ids.length);
      const results: Dict[] = [];
      for (const workoutId of ids) {
        try {
          await ctx.api(`/workout-service/workout/${workoutId}`, { method: "DELETE" });
          results.push({
            status: "success",
            workout_id: workoutId,
            message: `Workout ${workoutId} deleted successfully`,
          });
        } catch (e) {
          results.push({
            status: "error",
            workout_id: workoutId,
            message: `Error deleting workout: ${errMsg(e)}`,
          });
        }
      }
      const succeeded = results.filter((r) => r.status === "success").length;
      return { total: results.length, succeeded, failed: results.length - succeeded, results };
    },
  },
  {
    name: "get_scheduled_workouts",
    desc: `Get scheduled workouts between two dates with curated summary list

Returns workouts that have been scheduled on the Garmin Connect calendar,
including their scheduled dates and completion status.`,
    params: {
      start_date: dateStr.describe("Start date in YYYY-MM-DD format"),
      end_date: dateStr.describe("End date in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      const result = (await gql(
        ctx,
        `query{workoutScheduleSummariesScalar(startDate:"${args.start_date}", endDate:"${args.end_date}")}`
      )) as Dict;
      if (!isDict(result) || !("data" in result)) {
        return "No scheduled workouts found or error querying data.";
      }
      const scheduled: Dict[] = result.data?.workoutScheduleSummariesScalar ?? [];
      if (!Array.isArray(scheduled) || !scheduled.length) {
        return `No workouts scheduled between ${args.start_date} and ${args.end_date}.`;
      }
      return {
        count: scheduled.length,
        date_range: { start: args.start_date, end: args.end_date },
        scheduled_workouts: scheduled.map(curateScheduledWorkout),
      };
    },
  },
  {
    name: "get_garmin_coach_workouts",
    desc: `Get Garmin Coach workouts around the given date

Returns workouts from the active Garmin Coach/training plan, including
plan metadata, workout identifiers, dates, sport, duration, completion
status, rest days, race days, and workout intent when Garmin provides
them. Adaptive plans expose only Garmin's currently generated window,
typically the current week; future dates may return no workouts even
while a plan is active. The count includes rest-day entries.

Garmin's standalone Daily Suggested Workouts are generated on compatible
devices. As of July 31, 2026, no supported or known Garmin Connect
web/API endpoint returns the device's upcoming DSW schedule. This tool
returns Garmin Coach/training-plan workouts and does not synthesize
device-generated suggestions.

This is the preferred tool for Garmin Coach requests. The legacy
get_training_plan_workouts tool returns the same data; do not call both.

Adaptive Coach plans typically expose workout_uuid; other plan families
may expose numeric workout_id. Pass whichever identifier is present to
get_workout_by_id. Rest-day UUIDs may return minimal detail without
workout segments.`,
    params: {
      calendar_date: dateStr.describe(
        "Reference date in YYYY-MM-DD format (returns week's workouts)"
      ),
    },
    run: (args, ctx) => getGarminCoachWorkouts(ctx, args.calendar_date),
  },
  {
    name: "get_training_plan_workouts",
    desc: `Compatibility alias for get_garmin_coach_workouts

Prefer get_garmin_coach_workouts for new requests. This legacy tool
returns the same Garmin Coach/training-plan data; do not call both for
one request. Adaptive plans expose only Garmin's currently generated
window, typically the current week; future dates may return no workouts
even while a plan is active.

Adaptive training plans typically expose workout_uuid; other plan
families may expose numeric workout_id. Pass whichever identifier is
present to get_workout_by_id. The returned count includes rest days.`,
    params: {
      calendar_date: dateStr.describe(
        "Reference date in YYYY-MM-DD format (returns week's workouts)"
      ),
    },
    run: (args, ctx) => getGarminCoachWorkouts(ctx, args.calendar_date),
  },
  {
    name: "schedule_workout",
    desc: `Schedule a workout to a specific calendar date

This adds an existing workout from your Garmin workout library
to your Garmin Connect calendar on the specified date.

Idempotent: if the workout is already scheduled for that date, this
is a no-op that reports success without creating a duplicate entry.`,
    params: {
      workout_id: z.number().describe("ID of the workout to schedule (get IDs from get_workouts)"),
      calendar_date: dateStr.describe("Date to schedule the workout in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      if (await isAlreadyScheduled(ctx, args.workout_id, args.calendar_date)) {
        return {
          status: "success",
          workout_id: args.workout_id,
          scheduled_date: args.calendar_date,
          idempotent: true,
          message: `Workout ${args.workout_id} already scheduled for ${args.calendar_date} — no action taken`,
        };
      }
      await scheduleWorkoutPost(ctx, args.workout_id, args.calendar_date);
      return {
        status: "success",
        workout_id: args.workout_id,
        scheduled_date: args.calendar_date,
        message: `Successfully scheduled workout ${args.workout_id} for ${args.calendar_date}`,
      };
    },
  },
  {
    name: "schedule_workouts",
    desc: `Schedule multiple workouts to specific calendar dates

This adds workouts to your Garmin Connect calendar in a single call.
Each item can either reference an existing workout by ID, or provide
inline workout_data to upload-and-schedule in one step.

Idempotent per item: an already-scheduled workout is reported as success
without creating a duplicate entry. Max 40 items per call.

Examples:
    Schedule existing workouts by ID:
    [{"workout_id": 123456, "calendar_date": "2024-01-15"},
     {"workout_id": 789012, "calendar_date": "2024-01-17"}]

    Upload and schedule inline:
    [{"calendar_date": "2024-01-15", "workout_data": {"workoutName": "Easy Run", ...}},
     {"workout_id": 789012, "calendar_date": "2024-01-17"}]`,
    params: {
      schedules: z
        .array(z.record(z.any()))
        .describe(
          "List of schedules, each with: calendar_date (YYYY-MM-DD, required); workout_id (number, required unless workout_data is provided); workout_data (object, optional inline workout JSON to upload first then schedule — same structure and target-value rules as upload_workout)"
        ),
    },
    run: async (args, ctx) => {
      const schedules = args.schedules as Dict[];
      capBatch(schedules.length);
      const results: Dict[] = [];

      for (const item of schedules) {
        let workoutId: number | undefined = item.workout_id;
        const calendarDate: string | undefined = item.calendar_date;
        const workoutData: Dict | undefined = item.workout_data;

        if (calendarDate == null) {
          results.push({
            status: "failed",
            workout_id: workoutId,
            scheduled_date: calendarDate,
            message: "Missing required field: calendar_date",
          });
          continue;
        }
        try {
          validateDate(calendarDate, "calendar_date");
        } catch (e) {
          results.push({
            status: "failed",
            workout_id: workoutId,
            scheduled_date: calendarDate,
            message: errMsg(e),
          });
          continue;
        }
        if (workoutId == null && workoutData == null) {
          results.push({
            status: "failed",
            workout_id: null,
            scheduled_date: calendarDate,
            message: "Missing required fields: provide either workout_id or workout_data",
          });
          continue;
        }

        try {
          let workoutName: string | undefined;

          if (workoutData != null) {
            // Upload the workout first, then use the returned ID to schedule
            const uploadResult = await uploadWithGuards(ctx, workoutData);
            if (!isDict(uploadResult) || uploadResult.workoutId == null) {
              results.push({
                status: "failed",
                scheduled_date: calendarDate,
                message: "Upload succeeded but no workout_id returned",
              });
              continue;
            }
            workoutId = uploadResult.workoutId as number;
            workoutName = uploadResult.workoutName;
          }

          if (await isAlreadyScheduled(ctx, workoutId as number, calendarDate)) {
            const entry: Dict = {
              status: "success",
              workout_id: workoutId,
              scheduled_date: calendarDate,
              idempotent: true,
              message: `Workout ${workoutId} already scheduled for ${calendarDate} — no action taken`,
            };
            if (workoutName) entry.workout_name = workoutName;
            results.push(entry);
            continue;
          }

          await scheduleWorkoutPost(ctx, workoutId as number, calendarDate);
          const entry: Dict = {
            status: "success",
            workout_id: workoutId,
            scheduled_date: calendarDate,
            message: `Successfully scheduled workout ${workoutId} for ${calendarDate}`,
          };
          if (workoutName) entry.workout_name = workoutName;
          results.push(entry);
        } catch (e) {
          results.push({
            status: "error",
            workout_id: workoutId,
            scheduled_date: calendarDate,
            message: `Error scheduling workout: ${errMsg(e)}`,
          });
        }
      }

      const succeeded = results.filter((r) => r.status === "success").length;
      return { total: results.length, succeeded, failed: results.length - succeeded, results };
    },
  },
  {
    name: "unschedule_workout",
    desc: `Remove a scheduled workout from the Garmin Connect calendar

Deletes a calendar entry without deleting the underlying workout
template — the workout stays in your library and can be re-scheduled.

IMPORTANT: scheduled_workout_id is the calendar-entry id, which is
different from the workout's id. Get it from get_scheduled_workouts
(the "scheduled_workout_id" field), not from get_workouts.

Note: the scheduled-workouts listing is an eventually-consistent index.
If you just scheduled this workout, allow a moment before unscheduling
so the id is available.`,
    params: {
      scheduled_workout_id: z
        .number()
        .describe("Calendar-entry id from get_scheduled_workouts"),
    },
    run: async (args, ctx) => {
      try {
        await ctx.api(`/workout-service/schedule/${args.scheduled_workout_id}`, {
          method: "DELETE",
        });
        return {
          status: "success",
          scheduled_workout_id: args.scheduled_workout_id,
          message: `Scheduled workout ${args.scheduled_workout_id} removed from calendar`,
        };
      } catch (e) {
        return {
          status: "failed",
          scheduled_workout_id: args.scheduled_workout_id,
          message: `Failed to unschedule workout: ${errMsg(e)}`,
        };
      }
    },
  },
  {
    name: "unschedule_workouts",
    desc: `Remove multiple scheduled workouts from the Garmin Connect calendar

Deletes multiple calendar entries in a single call. The underlying
workout templates are left intact in your library.

IMPORTANT: each id is a calendar-entry id (the "scheduled_workout_id"
field from get_scheduled_workouts), not a workout id.

Max 40 ids per call.`,
    params: {
      scheduled_workout_ids: z
        .array(z.number())
        .describe("List of calendar-entry ids from get_scheduled_workouts"),
    },
    run: async (args, ctx) => {
      const ids = args.scheduled_workout_ids as number[];
      capBatch(ids.length);
      const results: Dict[] = [];
      for (const scheduledWorkoutId of ids) {
        try {
          await ctx.api(`/workout-service/schedule/${scheduledWorkoutId}`, { method: "DELETE" });
          results.push({
            status: "success",
            scheduled_workout_id: scheduledWorkoutId,
            message: `Scheduled workout ${scheduledWorkoutId} removed from calendar`,
          });
        } catch (e) {
          results.push({
            status: "error",
            scheduled_workout_id: scheduledWorkoutId,
            message: `Error unscheduling workout: ${errMsg(e)}`,
          });
        }
      }
      const succeeded = results.filter((r) => r.status === "success").length;
      return { total: results.length, succeeded, failed: results.length - succeeded, results };
    },
  },

  // --------------------------------------------------------------------------
  // High-level builders
  // --------------------------------------------------------------------------

  {
    name: "create_walk_run_workout",
    desc: `Create a walk/run interval workout and upload it to Garmin Connect.

Builds the internal Garmin JSON automatically and returns the new workout ID.`,
    params: {
      name: z.string().describe('Workout name (e.g. "W3 Mié 2:2")'),
      run_seconds: z.number().int().describe("Duration of each run interval in seconds"),
      walk_seconds: z.number().int().describe("Duration of each walk/recovery interval in seconds"),
      repeats: z.number().int().describe("Number of run/walk repetitions"),
      warmup_min: z.number().int().describe("Warmup duration in minutes"),
      cooldown_min: z.number().int().describe("Cooldown duration in minutes"),
      hr_zone: z.string().default("Z3").describe("Target heart-rate zone (Z1-Z5, default Z3)"),
    },
    run: async (args, ctx) => {
      const workoutJson = buildWalkRunJson(
        args.name,
        args.run_seconds,
        args.walk_seconds,
        args.repeats,
        args.warmup_min,
        args.cooldown_min,
        args.hr_zone ?? "Z3"
      );
      return curateUploadResult(await postWorkout(ctx, workoutJson));
    },
  },
  {
    name: "create_run_workout",
    desc: `Create a continuous run workout and upload it to Garmin Connect.

Builds a single uninterrupted run interval with warmup and cooldown walks.

Targets a named Garmin heart-rate zone by default. Named zones (Z1-Z5)
don't line up with every real training target — e.g. a 136-148 bpm
Zone 2 goal straddles Garmin's Z2 (118-137) and Z3 (138-157). Pass
hr_min and hr_max together to target that exact bpm range instead;
the watch will then show "in range" only for the range you actually
want, not a whole zone that over- or under-shoots it.`,
    params: {
      name: z.string().describe('Workout name (e.g. "Step 8 - 30min continuous")'),
      run_seconds: z.number().int().describe("Duration of the run in seconds"),
      warmup_min: z.number().int().describe("Warmup walk duration in minutes"),
      cooldown_min: z.number().int().describe("Cooldown walk duration in minutes"),
      hr_zone: z
        .string()
        .default("Z3")
        .describe("Target heart-rate zone (Z1-Z5, default Z3). Ignored if hr_min/hr_max are given."),
      hr_min: z
        .number()
        .int()
        .optional()
        .describe("Optional custom target heart rate range, minimum bpm (must be given with hr_max)"),
      hr_max: z
        .number()
        .int()
        .optional()
        .describe("Optional custom target heart rate range, maximum bpm (must be given with hr_min)"),
    },
    run: async (args, ctx) => {
      const workoutJson = buildRunJson(
        args.name,
        args.run_seconds,
        args.warmup_min,
        args.cooldown_min,
        args.hr_zone ?? "Z3",
        args.hr_min,
        args.hr_max
      );
      return curateUploadResult(await postWorkout(ctx, workoutJson));
    },
  },
  {
    name: "create_z2_walk_workout",
    desc: "Create a steady Z2 walking workout and upload it to Garmin Connect.",
    params: {
      name: z.string().describe("Workout name"),
      duration_min: z.number().int().describe("Main walking block duration in minutes"),
      hr_min: z
        .number()
        .int()
        .describe("Minimum heart rate in bpm (used for description; target is Z2)"),
      hr_max: z
        .number()
        .int()
        .describe("Maximum heart rate in bpm (used for description; target is Z2)"),
    },
    run: async (args, ctx) => {
      const workoutJson = buildZ2WalkJson(args.name, args.duration_min, args.hr_min, args.hr_max);
      return curateUploadResult(await postWorkout(ctx, workoutJson));
    },
  },
  {
    name: "create_strength_workout",
    desc: `Create a strength workout and upload it to Garmin Connect.

Each exercise becomes a reps-based step. The name is kept in the step
description; it is also sent as exerciseName, which Garmin only retains when
it matches one of its own exercise keys (e.g. "FARMERS_CARRY").`,
    params: {
      name: z.string().describe("Workout name"),
      exercises: z
        .array(z.record(z.any()))
        .describe(
          'List of dicts with keys: name, sets, reps, rest_seconds and an optional category. Category is omitted from the payload when not given; Garmin accepts that. When given it must be one of Garmin\'s exercise categories (e.g. SQUAT, DEADLIFT, PUSH_UP, CARRY, SLED) — anything else, including "UNASSIGNED" and "OTHER", is rejected with 400 Invalid category. Full list: https://connect.garmin.com/web-data/exercises/Exercises.json'
        ),
    },
    run: async (args, ctx) => {
      const workoutJson = buildStrengthJson(args.name, args.exercises as Dict[]);
      return curateUploadResult(await postWorkout(ctx, workoutJson));
    },
  },
  {
    name: "schedule_week",
    desc: `Schedule a list of workouts for the week in a single call.

Idempotent: if a workout is already scheduled for that date, it is
reported as already scheduled and the POST is skipped (avoids
duplicating calendar entries).`,
    params: {
      week: z
        .array(z.record(z.any()))
        .describe("List of dicts with keys: date (YYYY-MM-DD), workout_id (number)"),
    },
    run: async (args, ctx) => {
      const week = args.week as Dict[];
      const results: Dict[] = [];
      for (const item of week) {
        const calendarDate: string | undefined = item.date;
        const workoutId = Math.trunc(Number(item.workout_id));
        try {
          if (!calendarDate || item.workout_id == null || !Number.isFinite(workoutId)) {
            throw new Error("each item requires date and workout_id");
          }
          if (await isAlreadyScheduled(ctx, workoutId, calendarDate)) {
            results.push({
              date: calendarDate,
              workout_id: workoutId,
              status: "already_scheduled",
              idempotent: true,
            });
            continue;
          }
          await scheduleWorkoutPost(ctx, workoutId, calendarDate);
          results.push({ date: calendarDate, workout_id: workoutId, status: "scheduled" });
        } catch (e) {
          results.push({
            date: calendarDate,
            workout_id: item.workout_id,
            status: "failed",
            message: errMsg(e),
          });
        }
      }
      return { status: "complete", scheduled: results };
    },
  },
];

// ============================================================================
// Static workout template resources (verbatim from the Python module)
// ============================================================================

const SIMPLE_RUN_TEMPLATE = {
  workoutName: "Simple Run",
  description: "Basic run workout: warmup, run, cooldown",
  sportType: { sportTypeId: 1, sportTypeKey: "running" },
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSteps: [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
          description: "Warmup 5 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 300.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 2,
          stepType: { stepTypeId: 3, stepTypeKey: "interval" },
          description: "Run 20 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 1200.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 3,
          stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
          description: "Cooldown 5 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 300.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
      ],
    },
  ],
};

const INTERVAL_RUNNING_TEMPLATE = {
  workoutName: "Interval Run",
  description:
    "Interval workout with repeat groups: warmup, 6x(400m fast + 2min recovery), cooldown",
  sportType: { sportTypeId: 1, sportTypeKey: "running" },
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSteps: [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
          description: "Warmup 10 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 600.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 2,
          numberOfIterations: 6,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 1,
              stepType: { stepTypeId: 3, stepTypeKey: "interval" },
              description: "Fast 400m",
              endCondition: { conditionTypeId: 3, conditionTypeKey: "distance" },
              endConditionValue: 400.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 2,
              stepType: { stepTypeId: 4, stepTypeKey: "recovery" },
              description: "Recovery 2 min",
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
              endConditionValue: 120.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
            },
          ],
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 3,
          stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
          description: "Cooldown 10 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 600.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
      ],
    },
  ],
};

const TEMPO_RUN_TEMPLATE = {
  workoutName: "Tempo Run",
  description: "Tempo workout: warmup, 20min at tempo pace (HR zone 4), cooldown",
  sportType: { sportTypeId: 1, sportTypeKey: "running" },
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: { sportTypeId: 1, sportTypeKey: "running" },
      workoutSteps: [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
          description: "Warmup 10 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 600.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 2,
          stepType: { stepTypeId: 3, stepTypeKey: "interval" },
          description: "Tempo 20 min - HR Zone 4",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 1200.0,
          targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone" },
          zoneNumber: 4,
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 3,
          stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
          description: "Cooldown 10 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 600.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
      ],
    },
  ],
};

const STRENGTH_CIRCUIT_TEMPLATE = {
  workoutName: "Strength Circuit",
  description: "Strength training circuit: warmup, 3x circuit (work + rest), cooldown",
  sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
  workoutSegments: [
    {
      segmentOrder: 1,
      sportType: { sportTypeId: 5, sportTypeKey: "strength_training" },
      workoutSteps: [
        {
          type: "ExecutableStepDTO",
          stepOrder: 1,
          stepType: { stepTypeId: 1, stepTypeKey: "warmup" },
          description: "Warmup 5 min",
          endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button" },
          endConditionValue: 10.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
          category: "CARDIO",
          exerciseName: "",
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 2,
          numberOfIterations: 3,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 1,
              stepType: { stepTypeId: 3, stepTypeKey: "interval" },
              description: "Bench Press 10 reps",
              endCondition: { conditionTypeId: 10, conditionTypeKey: "reps" },
              endConditionValue: 10.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
              category: "BENCH_PRESS",
              exerciseName: "BARBELL_BENCH_PRESS",
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 2,
              stepType: { stepTypeId: 5, stepTypeKey: "rest" },
              description: "Rest 2 min",
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
              endConditionValue: 120.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
            },
          ],
        },
        {
          type: "RepeatGroupDTO",
          stepOrder: 3,
          numberOfIterations: 3,
          workoutSteps: [
            {
              type: "ExecutableStepDTO",
              stepOrder: 1,
              stepType: { stepTypeId: 3, stepTypeKey: "interval" },
              description: "Pull-ups 8 reps",
              endCondition: { conditionTypeId: 10, conditionTypeKey: "reps" },
              endConditionValue: 8.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
              category: "PULL_UP",
              exerciseName: "PULL_UP",
            },
            {
              type: "ExecutableStepDTO",
              stepOrder: 2,
              stepType: { stepTypeId: 5, stepTypeKey: "rest" },
              description: "Rest 2 min",
              endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
              endConditionValue: 120.0,
              targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
            },
          ],
        },
        {
          type: "ExecutableStepDTO",
          stepOrder: 4,
          stepType: { stepTypeId: 2, stepTypeKey: "cooldown" },
          description: "Cooldown stretch 5 min",
          endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
          endConditionValue: 300.0,
          targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" },
        },
      ],
    },
  ],
};

const WORKOUT_STRUCTURE_REFERENCE = {
  description: "Reference guide for Garmin workout JSON structure",
  step_types: {
    ExecutableStepDTO: "Regular workout step (warmup, interval, cooldown, recovery, rest)",
    RepeatGroupDTO: "Repeat group containing nested steps with numberOfIterations",
  },
  stepType_values: {
    "1": { stepTypeKey: "warmup", description: "Warmup phase" },
    "2": { stepTypeKey: "cooldown", description: "Cooldown phase" },
    "3": {
      stepTypeKey: "interval",
      description: "Work/effort interval (use for exercises in strength workouts)",
    },
    "4": { stepTypeKey: "recovery", description: "Recovery between intervals (active recovery)" },
    "5": {
      stepTypeKey: "rest",
      description: "Complete rest (use for rest between sets in strength workouts)",
    },
    "6": {
      stepTypeKey: "repeat",
      description: "Repeat group step type (used internally by RepeatGroupDTO)",
    },
  },
  endCondition_values: {
    "1": {
      conditionTypeKey: "lap.button",
      description: "Manual lap press (use for warmup/cooldown in strength workouts)",
    },
    "2": { conditionTypeKey: "time", description: "Duration in seconds" },
    "3": { conditionTypeKey: "distance", description: "Distance in meters" },
    "4": { conditionTypeKey: "calories", description: "Calories in kcal" },
    "5": { conditionTypeKey: "power", description: "Power in watts" },
    "6": { conditionTypeKey: "heart.rate", description: "Heart rate in bpm" },
    "7": {
      conditionTypeKey: "iterations",
      description: "Number of iterations (used internally by RepeatGroupDTO)",
    },
    "8": { conditionTypeKey: "fixed.rest", description: "Fixed rest duration" },
    "9": { conditionTypeKey: "fixed.repetition", description: "Fixed repetition count" },
    "10": {
      conditionTypeKey: "reps",
      description: "Number of repetitions (use for strength exercises)",
    },
    "11": { conditionTypeKey: "training.peaks.tss", description: "TrainingPeaks TSS" },
  },
  targetType_values: {
    "1": { workoutTargetTypeKey: "no.target", description: "No specific target" },
    "2": {
      workoutTargetTypeKey: "power.zone",
      description:
        "Cycling power zone 1-7 (use zoneNumber; based on FTP %). Do NOT use for absolute watt targets.",
    },
    "4": {
      workoutTargetTypeKey: "heart.rate.zone",
      description:
        "Heart rate zone (use zoneNumber 1-5 for named zones, or targetValueOne/targetValueTwo for custom bpm range)",
    },
    "6 (running/swim)": {
      workoutTargetTypeKey: "pace.zone",
      description:
        "Pace zone for running or swimming (use zoneNumber, or step-level targetValueOne/targetValueTwo in m/s for a custom range)",
    },
    "6 (cycling)": {
      workoutTargetTypeKey: "power.between",
      description:
        "Cycling absolute watt range (use targetValueOne=low_watts, targetValueTwo=high_watts). Use this instead of power.zone when targeting specific watts, NOT zone numbers.",
    },
  },
  sportType_values: {
    "1": { sportTypeKey: "running" },
    "2": { sportTypeKey: "cycling" },
    "3": { sportTypeKey: "other" },
    "4": { sportTypeKey: "lap_swimming" },
    "5": { sportTypeKey: "strength_training" },
    "6": { sportTypeKey: "cardio_training" },
    "7": { sportTypeKey: "yoga" },
    "8": { sportTypeKey: "pilates" },
    "9": { sportTypeKey: "hiit" },
    "11": { sportTypeKey: "mobility" },
    "12": { sportTypeKey: "walking" },
    "13": { sportTypeKey: "rucking" },
  },
  strength_training_fields: {
    description: "Additional fields for strength training workout steps (ExecutableStepDTO)",
    category:
      "Exercise category (e.g., BENCH_PRESS, PULL_UP, CURL, SHOULDER_PRESS, ROW, SQUAT, DEADLIFT, TRICEPS_EXTENSION, PLANK, LUNGE, CARDIO)",
    exerciseName:
      "Specific exercise name (e.g., BARBELL_BENCH_PRESS, PULL_UP, DUMBBELL_BICEPS_CURL, DUMBBELL_SHOULDER_PRESS, BENT_OVER_ROW_WITH_DUMBELL, BODY_WEIGHT_DIP)",
    weightValue: "Weight value as number (e.g., 24.0)",
    weightUnit: 'Weight unit object: {"unitId": 8, "unitKey": "kilogram", "factor": 1000.0}',
  },
};

export const resources: { name: string; uri: string; text: string }[] = [
  {
    name: "get_simple_run_template",
    uri: "workout://templates/simple-run",
    text: JSON.stringify(SIMPLE_RUN_TEMPLATE, null, 2),
  },
  {
    name: "get_interval_template",
    uri: "workout://templates/interval-running",
    text: JSON.stringify(INTERVAL_RUNNING_TEMPLATE, null, 2),
  },
  {
    name: "get_tempo_template",
    uri: "workout://templates/tempo-run",
    text: JSON.stringify(TEMPO_RUN_TEMPLATE, null, 2),
  },
  {
    name: "get_strength_template",
    uri: "workout://templates/strength-circuit",
    text: JSON.stringify(STRENGTH_CIRCUIT_TEMPLATE, null, 2),
  },
  {
    name: "get_structure_reference",
    uri: "workout://reference/structure",
    text: JSON.stringify(WORKOUT_STRUCTURE_REFERENCE, null, 2),
  },
];
