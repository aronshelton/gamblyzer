/**
 * Integration test: pick one MLB line, then fetch Odds API historical snapshot for line movement.
 * Usage: node --env-file=.env.local scripts/test-historical-line-movement.mjs
 */
import { generatePickOnly, probeHistoricalLineMovement } from "../lib/gamblyzer5-web.js";

async function main() {
  if (!process.env.ODDS_API_KEY) {
    console.error("FAIL: ODDS_API_KEY missing (use: node --env-file=.env.local scripts/test-historical-line-movement.mjs)");
    process.exit(1);
  }

  console.log("1) Fetching a sample MLB pick from live odds…");
  const pick = await generatePickOnly({
    league: "MLB",
    min: -120,
    max: 120,
    pickIndex: 0,
  });

  console.log(
    `   Game: ${pick.fixture.participant2Name} @ ${pick.fixture.participant1Name}`
  );
  console.log(`   Event id: ${pick.fixture.fixtureId}`);
  console.log(`   Bet: ${pick.dkRow.outcome} (${pick.dkRow.bucket}) @ ${pick.dkRow.american}`);

  console.log("\n2) Probing historical line movement…");
  const block = await probeHistoricalLineMovement(pick);

  if (!block) {
    console.error("\nFAIL: No LINE MOVEMENT block returned (check server logs / paid historical plan).");
    process.exit(2);
  }

  console.log("\nOK — LINE MOVEMENT block:\n");
  console.log(block);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFAIL:", e?.message || e);
  process.exit(3);
});
