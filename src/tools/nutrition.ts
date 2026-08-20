import { z } from "zod";
import type { Ctx, ToolDef } from "../toolkit";
import { dateStr, stripNulls } from "../toolkit";

// Garmin's API expects integer strings like "160" not "160.0"
function numToStr(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

function utcLogTimestamp(): string {
  return new Date().toISOString().slice(0, 19) + ".000Z";
}

// snake_case param -> Garmin nutrition field
const NUTRIENTS = [
  ["carbs", "carbs"],
  ["protein", "protein"],
  ["fat", "fat"],
  ["fiber", "fiber"],
  ["sugar", "sugar"],
  ["saturated_fat", "saturatedFat"],
  ["sodium", "sodium"],
  ["cholesterol", "cholesterol"],
  ["potassium", "potassium"],
  ["trans_fat", "transFat"],
  ["calcium", "calcium"],
  ["iron", "iron"],
  ["vitamin_d", "vitaminD"],
] as const;

const nutrientParams = {
  carbs: z.number().optional().describe("Carbohydrates in grams per serving"),
  protein: z.number().optional().describe("Protein in grams per serving"),
  fat: z.number().optional().describe("Total fat in grams per serving"),
  fiber: z.number().optional().describe("Fiber in grams per serving"),
  sugar: z.number().optional().describe("Sugar in grams per serving"),
  saturated_fat: z.number().optional().describe("Saturated fat in grams per serving"),
  sodium: z.number().optional().describe("Sodium in mg per serving"),
  cholesterol: z.number().optional().describe("Cholesterol in mg per serving"),
  potassium: z.number().optional().describe("Potassium in mg per serving"),
  trans_fat: z.number().optional().describe("Trans fat in grams per serving"),
  calcium: z.number().optional().describe("Calcium in mg per serving (NOT %DV)"),
  iron: z.number().optional().describe("Iron in mg per serving (NOT %DV)"),
  vitamin_d: z.number().optional().describe("Vitamin D in mcg per serving (NOT %DV)"),
};

const servingParams = {
  serving_unit: z.string().default("G").describe('Unit for serving size (e.g. "G", "ML", "OZ"). Default "G"'),
  number_of_units: z.number().default(100).describe("Serving size in the specified unit. Default 100"),
};

const mealTimeParam = z
  .string()
  .describe('Time in HH:MM:SS format (e.g. "12:30:00", account timezone); used to determine the meal automatically');

function buildNutrition(args: Record<string, any>, base: Record<string, any>): Record<string, any> {
  const nutrition: Record<string, any> = {
    ...base,
    servingUnit: args.serving_unit,
    numberOfUnits: numToStr(args.number_of_units),
    calories: numToStr(args.calories),
  };
  for (const [param, apiKey] of NUTRIENTS) {
    if (args[param] !== undefined) nutrition[apiKey] = numToStr(args[param]);
  }
  return nutrition;
}

async function searchCustomFoods(ctx: Ctx, search: string, limit: number): Promise<Record<string, any>[]> {
  const data = (await ctx.api("/nutrition-service/customFood", {
    params: { searchExpression: search, start: "0", limit: String(limit), includeContent: "true" },
  })) as Record<string, any>;
  return Array.isArray(data?.customFoods) ? data.customFoods : [];
}

// exact case-insensitive name match to avoid duplicate foods
function matchByName(foods: Record<string, any>[], foodName: string) {
  for (const f of foods) {
    const meta = f.foodMetaData ?? f;
    if (String(meta.foodName ?? "").toLowerCase() === foodName.toLowerCase()) {
      return {
        foodId: String(meta.foodId ?? f.foodId ?? ""),
        servingId: f.nutritionContents?.length ? String(f.nutritionContents[0].servingId ?? "") : "",
      };
    }
  }
  return undefined;
}

// pick meal whose startTime <= meal_time <= endTime, else SNACKS
async function resolveMealId(ctx: Ctx, mealDate: string, mealTime: string): Promise<unknown> {
  const data = (await ctx.api(`/nutrition-service/meals/${mealDate}`)) as Record<string, any>;
  const meals: Record<string, any>[] = Array.isArray(data?.meals) ? data.meals : [];
  for (const m of meals) {
    if (m.startTime && m.endTime && m.startTime <= mealTime && mealTime <= m.endTime) return m.mealId;
  }
  const snacks = meals.find((m) => m.mealName === "SNACKS");
  if (!snacks) throw new Error(`could not match meal for time '${mealTime}' and no SNACKS meal found`);
  return snacks.mealId;
}

function logFoodItem(
  mealDate: string,
  mealTime: string,
  mealId: unknown,
  foodId: string,
  servingId: string,
  servingQty: number,
  source: string
) {
  return {
    mealDate,
    foodLogItems: [
      {
        logTimestamp: utcLogTimestamp(),
        logSource: "GCW",
        logCategory: "REGULAR_LOG",
        mealTime,
        action: "ADD",
        mealId,
        foodId,
        servingId,
        source,
        regionCode: "US",
        languageCode: "en",
        servingQty,
      },
    ],
  };
}

export const tools: ToolDef[] = [
  {
    name: "get_nutrition_daily_food_log",
    desc: "Get daily food consumption records for a date. Returns food items logged throughout the day including calories, macronutrients, and meal associations.",
    params: { date: dateStr },
    run: (args, ctx) => ctx.api(`/nutrition-service/food/logs/${args.date}`),
  },
  {
    name: "get_nutrition_daily_meals",
    desc: "Get daily meal summaries for a date. Returns meal-level summaries (breakfast, lunch, dinner, snacks) with nutritional totals for each meal. Each meal includes a mealId needed for logging food items to that meal.",
    params: { date: dateStr },
    run: (args, ctx) => ctx.api(`/nutrition-service/meals/${args.date}`),
  },
  {
    name: "get_nutrition_daily_settings",
    desc: "Get nutrition plan/settings for a date. Returns the user's nutrition goals and targets including calorie targets, macronutrient goals, and plan configuration.",
    params: { date: dateStr },
    run: (args, ctx) => ctx.api(`/nutrition-service/settings/${args.date}`),
  },
  {
    name: "set_nutrition_daily_settings",
    desc: "Update daily nutrition goals (calorie target and macronutrient targets). Reads the current settings for the date, applies the supplied overrides, and writes the merged result back. Only the fields you provide are changed; omitted fields keep their existing values. Garmin stores macros as grams. The calorie goal should match 4*carbs + 4*protein + 9*fat to within a small rounding margin — Garmin accepts minor mismatches but will silently correct large discrepancies.",
    params: {
      date: dateStr.describe(
        "Date in YYYY-MM-DD format (settings are typically set once and inherited across days, but Garmin accepts per-day overrides)"
      ),
      calorie_goal: z.number().int().optional().describe("Daily calorie target in kcal"),
      carbs_grams: z.number().int().optional().describe("Daily carbohydrate target in grams"),
      fat_grams: z.number().int().optional().describe("Daily fat target in grams"),
      protein_grams: z.number().int().optional().describe("Daily protein target in grams"),
    },
    run: async (args, ctx) => {
      const { date, calorie_goal, carbs_grams, fat_grams, protein_grams } = args;
      if ([calorie_goal, carbs_grams, fat_grams, protein_grams].every((v) => v === undefined)) {
        throw new Error(
          "No fields to update — supply at least one of calorie_goal, carbs_grams, fat_grams, protein_grams."
        );
      }
      const url = `/nutrition-service/settings/${date}`;
      const current = (await ctx.api(url)) as Record<string, any>;
      // api() returns {ok:true,...} sentinel on an empty body
      if (!current || current.ok === true) {
        throw new Error(`Could not read current nutrition settings for ${date} — cannot apply update.`);
      }
      if (calorie_goal !== undefined) current.activeDailyCalories = calorie_goal;
      if (carbs_grams !== undefined) current.activeDailyCarbohydrateGrams = carbs_grams;
      if (fat_grams !== undefined) current.activeDailyFatGrams = fat_grams;
      if (protein_grams !== undefined) current.activeDailyProteinGrams = protein_grams;
      const resp = (await ctx.api(url, { method: "PUT", body: current })) as Record<string, any>;
      const result = resp && resp.ok !== true ? resp : current;
      return {
        status: "updated",
        date,
        calorie_goal: result.activeDailyCalories,
        carbs_grams: result.activeDailyCarbohydrateGrams,
        fat_grams: result.activeDailyFatGrams,
        protein_grams: result.activeDailyProteinGrams,
      };
    },
  },
  {
    name: "search_foods",
    desc: 'Search Garmin\'s general food catalog (FatSecret + Garmin custom foods). Searches across the entire food catalog including FatSecret-sourced branded and generic foods, not just the user\'s Garmin custom foods. Use this to find branded packaged foods by name before logging them. Returns food_id, source, name, brand, and all available servings with macros. The source field ("FATSECRET" or "GARMIN") and food_id together identify the right routing for log_custom_food — pass both to log_custom_food\'s food_id and source parameters respectively. For the user\'s own custom foods only, use get_custom_foods instead.',
    params: {
      query: z.string().describe('Food name or brand to search for (e.g. "Cheerios", "Greek yogurt")'),
      start: z.number().int().default(0).describe("Starting index for pagination (default 0)"),
      limit: z.number().int().default(20).describe("Maximum number of results per page (default 20)"),
    },
    run: async (args, ctx) => {
      const data = (await ctx.api("/nutrition-service/food/search", {
        params: { searchExpression: args.query, start: String(args.start), limit: String(args.limit) },
      })) as Record<string, any>;
      const raw: Record<string, any>[] = Array.isArray(data?.results) ? data.results : [];
      const results = raw.map((item) => {
        const meta = item.foodMetaData ?? {};
        const servings = (item.nutritionContents ?? []).map((s: Record<string, any>) =>
          stripNulls({
            serving_id: s.servingId,
            serving_unit: s.servingUnit,
            number_of_units: s.numberOfUnits,
            calories: s.calories,
            carbs_g: s.carbs,
            protein_g: s.protein,
            fat_g: s.fat,
            fiber_g: s.fiber,
            sodium_mg: s.sodium,
          })
        );
        return stripNulls({
          food_id: meta.foodId,
          name: meta.foodName,
          food_type: meta.foodType,
          source: meta.source,
          region: meta.regionCode,
          language: meta.languageCode,
          servings,
          ...(meta.brandName ? { brand: meta.brandName } : {}),
        });
      });
      return { count: results.length, has_more: Boolean(data?.moreDataAvailable), results };
    },
  },
  {
    name: "get_custom_foods",
    desc: "Search or list user's custom foods. Returns custom foods the user has created. Use the search parameter to find existing foods by name before creating duplicates — the response includes foodId and servingId needed for log_custom_food. For branded catalog foods (FatSecret), use search_foods instead.",
    params: {
      search: z.string().default("").describe("Search term to filter foods by name (default: list all)"),
      start: z.number().int().default(0).describe("Starting index for pagination (default 0)"),
      limit: z.number().int().default(20).describe("Maximum number of results (default 20)"),
    },
    run: (args, ctx) =>
      ctx.api("/nutrition-service/customFood", {
        params: {
          searchExpression: args.search,
          start: String(args.start),
          limit: String(args.limit),
          includeContent: "true",
        },
      }),
  },
  {
    name: "get_custom_food_serving_units",
    desc: "Get available serving units for custom foods. Returns the list of valid serving units (e.g. G, ML, OZ) that can be used when creating custom foods.",
    run: (_args, ctx) => ctx.api("/nutrition-service/metadata/customFoodServingUnits"),
  },
  {
    name: "create_custom_food",
    desc: "Create a custom food in the user's Garmin nutrition library. Creates a new food item with nutritional information per serving. On success the response includes foodId and servingId needed for log_custom_food. If the API returns no data (204), use get_custom_foods(search=food_name) to retrieve those IDs. All nutrient amounts are ABSOLUTE values per serving, not %DV. Nutrition labels often print %DV for calcium/iron/vitamin D — convert to absolute units before passing.",
    params: {
      food_name: z.string().describe('Name of the custom food (e.g. "Homemade Chocolate Cookies")'),
      calories: z.number().describe("Calories per serving"),
      ...servingParams,
      brand_name: z.string().optional().describe('Brand or vendor name (e.g. "Three Bridges")'),
      ...nutrientParams,
    },
    run: (args, ctx) => {
      const foodMetaData: Record<string, any> = {
        foodName: args.food_name,
        foodType: "GENERIC",
        source: "GARMIN",
        regionCode: "US",
        languageCode: "en",
      };
      if (args.brand_name !== undefined) foodMetaData.brandName = args.brand_name;
      return ctx.api("/nutrition-service/customFood", {
        method: "PUT",
        body: { foodMetaData, nutritionContents: [buildNutrition(args, {})] },
      });
    },
  },
  {
    name: "update_custom_food",
    desc: "Update an existing custom food in the user's Garmin nutrition library. Fetches the food's current record before writing so that omitted optional fields (brand, carbs, protein, fat, micros, etc.) preserve their existing values rather than being cleared. Only the fields you explicitly pass are changed; everything else is carried forward from the current record. All nutrient amounts are ABSOLUTE values per serving, not %DV. Nutrition labels often print %DV for calcium/iron/vitamin D — convert to absolute units before passing. Use get_custom_foods first to find the foodId and servingId.",
    params: {
      food_id: z.string().describe("ID of the custom food to update (from get_custom_foods)"),
      serving_id: z.string().describe("Serving ID of the food (from get_custom_foods)"),
      food_name: z.string().describe("Name of the custom food"),
      calories: z.number().describe("Calories per serving"),
      ...servingParams,
      brand_name: z.string().optional().describe("Brand or vendor name; omit to preserve the existing value"),
      ...nutrientParams,
    },
    run: async (args, ctx) => {
      let existingNutrition: Record<string, any> = {};
      let existingBrand: string | undefined;
      try {
        const foods = await searchCustomFoods(ctx, args.food_name, 20);
        for (const f of foods) {
          if (String(f.foodMetaData?.foodId ?? "") === args.food_id) {
            existingNutrition = f.nutritionContents?.[0] ?? {};
            existingBrand = f.foodMetaData?.brandName;
            break;
          }
        }
      } catch {
        // proceed without existing data; caller's values win
      }
      // carry forward existing optional fields, then overlay caller-supplied values
      const carried: Record<string, any> = {};
      const apiKeys = new Set<string>(NUTRIENTS.map(([, k]) => k));
      for (const [key, val] of Object.entries(existingNutrition)) {
        if (apiKeys.has(key) && val !== null && val !== undefined) carried[key] = numToStr(val);
      }
      const nutrition = { servingId: args.serving_id, ...buildNutrition(args, carried) };
      const effectiveBrand = args.brand_name ?? existingBrand;
      const foodMetaData: Record<string, any> = {
        foodId: args.food_id,
        foodName: args.food_name,
        foodType: "GENERIC",
        source: "GARMIN",
        regionCode: "US",
        languageCode: "en",
      };
      if (effectiveBrand !== undefined) foodMetaData.brandName = effectiveBrand;
      return ctx.api("/nutrition-service/customFood", {
        method: "PUT",
        body: { foodMetaData, nutritionContents: [nutrition] },
      });
    },
  },
  {
    name: "delete_custom_food",
    desc: "Delete a custom food from the user's Garmin nutrition library. Permanently removes a custom food entry. The food must not be actively referenced in a logged meal to be deleted. Use get_custom_foods to find the foodId.",
    params: {
      food_id: z
        .string()
        .describe("ID of the custom food to delete — a 32-char hex string (from get_custom_foods or create_custom_food)"),
    },
    run: async (args, ctx) => {
      await ctx.api(`/nutrition-service/customFood/${args.food_id}`, { method: "DELETE" });
      return {
        status: "success",
        food_id: args.food_id,
        message: `Custom food ${args.food_id} deleted successfully.`,
      };
    },
  },
  {
    name: "log_custom_food",
    desc: 'Log a food item to a meal on a date. Adds a food entry to the nutrition log. The meal is determined automatically by matching meal_time against each meal\'s startTime/endTime window; falls back to SNACKS if no window matches. Food sources: "GARMIN" (default) is the user\'s custom food library — use get_custom_foods to find food_id and serving_id; "FATSECRET" is branded/catalog food from FatSecret — use search_foods to find food_id and serving_id, and pass the source value from the search_foods result. Garmin custom food IDs are 32-char hex UUIDs; FatSecret IDs are numeric strings (e.g. "4132350"). Passing the wrong source for a given food_id returns a 400 from Garmin.',
    params: {
      meal_date: dateStr,
      meal_time: mealTimeParam,
      food_id: z.string().describe("Food ID from get_custom_foods (GARMIN) or search_foods (FATSECRET)"),
      serving_id: z.string().describe("Serving ID from get_custom_foods or search_foods"),
      serving_qty: z.number().default(1).describe("Number of servings (default 1)"),
      source: z.string().default("GARMIN").describe('Food namespace — "GARMIN" (default) or "FATSECRET"'),
    },
    run: async (args, ctx) => {
      const mealId = await resolveMealId(ctx, args.meal_date, args.meal_time);
      return ctx.api("/nutrition-service/food/logs", {
        method: "PUT",
        body: logFoodItem(
          args.meal_date,
          args.meal_time,
          mealId,
          args.food_id,
          args.serving_id,
          args.serving_qty,
          args.source
        ),
      });
    },
  },
  {
    name: "log_food",
    desc: "Quick-add a food entry with macro values to the nutrition log. Logs food directly by name and macros without requiring a food ID. Uses Garmin's Quick Add feature. The meal is determined automatically by matching meal_time against each meal's startTime/endTime window; falls back to SNACKS if no window matches.",
    params: {
      meal_date: dateStr,
      meal_time: mealTimeParam,
      name: z.string().describe("Display name for the food entry"),
      calories: z.number().describe("Calories (kcal)"),
      carbs: z.number().describe("Carbohydrates in grams"),
      protein: z.number().describe("Protein in grams"),
      fat: z.number().describe("Fat in grams"),
    },
    run: async (args, ctx) => {
      const mealId = await resolveMealId(ctx, args.meal_date, args.meal_time);
      return ctx.api("/nutrition-service/food/logs/quickAdd", {
        method: "PUT",
        body: {
          mealDate: args.meal_date,
          quickAddItems: [
            {
              name: args.name,
              logId: null,
              logTimestamp: utcLogTimestamp(),
              logSource: "GCW",
              logCategory: "QUICK_ADD",
              mealTime: args.meal_time,
              mealId,
              action: "ADD",
              calories: numToStr(args.calories),
              carbs: numToStr(args.carbs),
              protein: numToStr(args.protein),
              fat: numToStr(args.fat),
            },
          ],
        },
      });
    },
  },
  {
    name: "delete_food_log",
    desc: "Delete a food log entry. Permanently removes a logged food item from the nutrition log. Works for both QUICK_ADD and REGULAR_LOG entry types. Use get_nutrition_daily_food_log to find the logId and date.",
    params: {
      log_id: z
        .string()
        .describe("Log entry ID to delete — a 32-char hex UUID (from get_nutrition_daily_food_log)"),
      meal_date: dateStr.describe("Date of the log entry in YYYY-MM-DD format"),
    },
    run: async (args, ctx) => {
      await ctx.api(`/nutrition-service/food/logs/${args.meal_date}`, {
        method: "DELETE",
        body: { logIds: [args.log_id] },
      });
      return {
        status: "success",
        log_id: args.log_id,
        message: `Food log entry ${args.log_id} deleted successfully.`,
      };
    },
  },
  {
    name: "upsert_and_log",
    desc: "Find-or-create a custom food then log it in one step. Searches the user's custom food library for food_name. If found, logs it immediately. If not found, creates it with the provided nutrition data and then logs it. This avoids duplicate food entries and removes the need for separate search → create → log round-trips.",
    params: {
      meal_date: dateStr,
      meal_time: mealTimeParam,
      food_name: z.string().describe("Name of the food to find or create"),
      calories: z.number().describe("Calories per serving"),
      carbs: z.number().optional().describe("Carbohydrates in grams per serving"),
      protein: z.number().optional().describe("Protein in grams per serving"),
      fat: z.number().optional().describe("Total fat in grams per serving"),
      ...servingParams,
      serving_qty: z.number().default(1).describe("Number of servings to log (default 1)"),
    },
    run: async (args, ctx) => {
      const found = matchByName(await searchCustomFoods(ctx, args.food_name, 10), args.food_name);
      let foodId = found?.foodId ?? "";
      let servingId = found?.servingId ?? "";

      if (!foodId || !servingId) {
        const createResp = (await ctx.api("/nutrition-service/customFood", {
          method: "PUT",
          body: {
            foodMetaData: {
              foodName: args.food_name,
              foodType: "GENERIC",
              source: "GARMIN",
              regionCode: "US",
              languageCode: "en",
            },
            nutritionContents: [buildNutrition(args, {})],
          },
        })) as Record<string, any>;
        const meta = createResp?.foodMetaData ?? createResp ?? {};
        foodId = meta.foodId != null ? String(meta.foodId) : "";
        const contents = createResp?.nutritionContents ?? [];
        if (contents.length) servingId = String(contents[0].servingId ?? "");
        // 204: no body — look up by name
        if (!foodId || !servingId) {
          const again = matchByName(await searchCustomFoods(ctx, args.food_name, 10), args.food_name);
          if (again) ({ foodId, servingId } = again);
        }
        if (!foodId || !servingId) {
          throw new Error(`could not retrieve foodId/servingId for '${args.food_name}' after creation`);
        }
      }

      const mealId = await resolveMealId(ctx, args.meal_date, args.meal_time);
      return ctx.api("/nutrition-service/food/logs", {
        method: "PUT",
        body: logFoodItem(
          args.meal_date,
          args.meal_time,
          mealId,
          foodId,
          servingId,
          args.serving_qty,
          "GARMIN"
        ),
      });
    },
  },
];
