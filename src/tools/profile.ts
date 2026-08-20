import { z } from "zod";
import type { ToolDef } from "../toolkit";

export const tools: ToolDef[] = [
  {
    name: "get_full_name",
    desc: "Get user's full name from profile",
    run: async (_args, ctx) => {
      const p = (await ctx.api("/userprofile-service/socialProfile")) as { fullName?: string };
      return { full_name: p.fullName };
    },
  },
  {
    name: "get_unit_system",
    desc: "Get user's preferred unit system from profile",
    run: async (_args, ctx) => {
      const s = (await ctx.api("/userprofile-service/userprofile/user-settings")) as {
        userData?: { measurementSystem?: string };
      };
      return { unit_system: s.userData?.measurementSystem };
    },
  },
  {
    name: "get_user_profile",
    desc: "Get user profile information",
    run: (_args, ctx) => ctx.api("/userprofile-service/userprofile/user-settings"),
  },
  {
    name: "get_userprofile_settings",
    desc: "Get user profile settings",
    run: (_args, ctx) => ctx.api("/userprofile-service/userprofile/settings"),
  },
  {
    name: "garmin_get",
    desc: "Raw GET against any Garmin Connect API path on connectapi.garmin.com. Escape hatch when no dedicated tool fits.",
    params: {
      path: z.string().describe("API path starting with /"),
      params: z.record(z.string()).optional().describe("Query parameters"),
    },
    run: (args, ctx) => ctx.api(args.path, { params: args.params }),
  },
];
