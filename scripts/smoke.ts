// Local check of the exact code the Worker runs: exchange + two API calls.
// Needs ~/.garminconnect from scripts/garmin-login.py. Run: npm run smoke
import { readFileSync } from "node:fs";
import { exchange, api } from "../src/garmin";

const dir = `${process.env.HOME}/.garminconnect`;
const oauth1 = JSON.parse(readFileSync(`${dir}/oauth1_token.json`, "utf8"));

const tok = await exchange(oauth1);
console.log("exchange OK, oauth2 expires:", new Date(tok.expires_at * 1000).toISOString());

const profile = (await api(tok.access_token, "/userprofile-service/socialProfile")) as {
  displayName: string;
};
if (!profile.displayName) throw new Error("no displayName in profile");
console.log("profile OK:", profile.displayName);

const acts = (await api(tok.access_token, "/activitylist-service/activities/search/activities", {
  params: { limit: "3", start: "0" },
})) as unknown[];
console.log(`activities OK: ${acts.length} returned`);
