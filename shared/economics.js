// Single source of truth for VEIL</>™ reward and revenue-share rules.
// Used by the control server and the web/extension UI.
export const RATE_PER_MIN = 0.1;            // $VEIL per eligible active minute
export const MAX_MIN = 240;                 // rewarded minutes per UTC day
export const MAX_DAY = RATE_PER_MIN * MAX_MIN; // 24 $VEIL
export const REF_PRICE = 0.01;              // USD per $VEIL, used only until a market price exists

// [name, minMembers, community, network, ecosystem, liquidity, team, treasuryBoost]
// Splits always add to 100% of ad revenue. The boost is a $VEIL top-up from the
// community treasury allocation, never extra cash.
export const TIERS = [
  ['Launch', 0, 50, 20, 15, 10, 5, 1.0],
  ['Growth', 100_000, 55, 17, 13, 10, 5, 1.25],
  ['Network', 1_000_000, 60, 15, 10, 10, 5, 1.5],
  ['Mass', 10_000_000, 65, 12, 8, 10, 5, 2.0],
];

export const tierOf = (members) => TIERS.reduce((t, x) => (members >= x[1] ? x : t), TIERS[0]);

export function split(members, revenueUsd) {
  const t = tierOf(members);
  const [name, , community, network, ecosystem, liquidity, team, boost] = t;
  const part = (p) => (revenueUsd * p) / 100;
  return {
    tier: name, boost,
    percent: { community, network, ecosystem, liquidity, team },
    usd: { community: part(community), network: part(network), ecosystem: part(ecosystem), liquidity: part(liquidity), team: part(team) },
  };
}

// Share of the community pool for one member, by rewarded minutes.
export function memberShare({ poolUsd, myMinutes, totalMinutes, boost, price = REF_PRICE }) {
  if (!totalMinutes || !myMinutes) return { usd: 0, veil: 0, weight: 0 };
  const weight = myMinutes / totalMinutes;
  const usd = poolUsd * weight;
  return { usd, veil: (usd / price) * boost, weight };
}
