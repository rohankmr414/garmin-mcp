// Deterministic check of the owner-allowlist predicate used in auth.ts finish().
// Run: npx tsx scripts/check-allowlist.ts
import { strict as assert } from "node:assert";

function denied(ownerIds: string | undefined, displayName: string): boolean {
  const allow = (ownerIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.length > 0 && !allow.includes(displayName);
}

const OWNER = "00000000-1111-2222-3333-444444444444"; // stand-in displayName fixture

// owner is allowed through
assert.equal(denied(OWNER, OWNER), false);
// any other Garmin account is blocked
assert.equal(denied(OWNER, "someone-else-uuid"), true);
// unset/empty allowlist = open (no lock)
assert.equal(denied(undefined, "anyone"), false);
assert.equal(denied("", "anyone"), false);
assert.equal(denied("  ", "anyone"), false);
// multi-owner allowlist with whitespace
assert.equal(denied(` ${OWNER} , second-id `, "second-id"), false);
assert.equal(denied(`${OWNER},second-id`, "third-id"), true);

console.log("allowlist predicate: all assertions passed");
