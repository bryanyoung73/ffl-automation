import { test, expect } from "@playwright/test";
import {
  impliedTotals,
  weatherBadness,
  parseScoreboard,
  parseKickoffTimes,
  parseGameStatus,
  vegasImpact,
} from "../src/intel/providers/vegas.js";

test("impliedTotals splits the over/under by the spread", () => {
  expect(impliedTotals(44.5, -3.5)).toEqual({ home: 24, away: 20.5 });
  expect(impliedTotals(50, 0)).toEqual({ home: 25, away: 25 });
  expect(impliedTotals(40, 7)).toEqual({ home: 16.5, away: 23.5 }); // home is a +7 dog
});

test("weatherBadness scales with conditions and cold", () => {
  expect(weatherBadness("Sunny", 72)).toBe(0);
  expect(weatherBadness("Rain", 55)).toBe(1);
  expect(weatherBadness("Snow", 30)).toBe(2);
  expect(weatherBadness("Rain", 15)).toBe(2); // rain + freezing -> cap 2
  expect(weatherBadness("Cloudy", 10)).toBe(1); // just cold
});

const scoreboard = {
  events: [
    {
      weather: { displayValue: "Snow", temperature: 22 },
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "GB" } },
            { homeAway: "away", team: { abbreviation: "CHI" } },
          ],
          odds: [{ overUnder: 40, spread: -6 }],
        },
      ],
    },
    {
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { abbreviation: "KC" } },
            { homeAway: "away", team: { abbreviation: "BUF" } },
          ],
          odds: [{ overUnder: 52, spread: -2 }],
        },
      ],
    },
  ],
};

test("parseScoreboard yields a context per team, both sides of each game", () => {
  const g = parseScoreboard(scoreboard);
  expect([...g.keys()].sort()).toEqual(["BUF", "CHI", "GB", "KC"]);

  const gb = g.get("GB")!;
  expect(gb).toMatchObject({ opponent: "CHI", home: true, spread: -6, impliedTotal: 23, opponentImpliedTotal: 17 });
  expect(gb.weatherBadness).toBe(2);

  const chi = g.get("CHI")!;
  expect(chi).toMatchObject({ spread: 6, impliedTotal: 17, opponentImpliedTotal: 23, home: false });

  const kc = g.get("KC")!;
  expect(kc.impliedTotal).toBe(27); // 52/2 + 1
  expect(kc.weatherBadness).toBe(0);
});

test("parseScoreboard skips games with no posted odds", () => {
  const g = parseScoreboard({
    events: [
      { competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "NYJ" } }], odds: [] }] },
    ],
  });
  expect(g.size).toBe(0);
});

test("parseKickoffTimes reads a per-team kickoff even when odds haven't posted yet", () => {
  // Real need: the lineup optimizer's flex tie-break (src/lineup/optimizer.ts)
  // needs kickoff times all week, not just once betting lines are up.
  const g = parseKickoffTimes({
    events: [
      {
        date: "2026-09-20T17:00Z",
        competitions: [
          {
            competitors: [
              { homeAway: "home", team: { abbreviation: "ATL" } },
              { homeAway: "away", team: { abbreviation: "CAR" } },
            ],
            odds: [],
          },
        ],
      },
      {
        competitions: [
          {
            date: "2026-09-21T20:20Z",
            competitors: [
              { homeAway: "home", team: { abbreviation: "KC" } },
              { homeAway: "away", team: { abbreviation: "BUF" } },
            ],
          },
        ],
      },
    ],
  });
  expect(g.get("ATL")).toBe("2026-09-20T17:00Z");
  expect(g.get("CAR")).toBe("2026-09-20T17:00Z");
  expect(g.get("KC")).toBe("2026-09-21T20:20Z");
  expect(g.get("BUF")).toBe("2026-09-21T20:20Z");
});

test("parseKickoffTimes skips events with no usable date", () => {
  const g = parseKickoffTimes({
    events: [{ competitions: [{ competitors: [{ homeAway: "home", team: { abbreviation: "NYJ" } }] }] }],
  });
  expect(g.size).toBe(0);
});

test("parseGameStatus reports completion per team, for use by recommendation-tracking grading", () => {
  const g = parseGameStatus({
    events: [
      {
        date: "2026-09-14T17:00Z",
        competitions: [
          {
            status: { type: { completed: true } },
            competitors: [
              { homeAway: "home", team: { abbreviation: "ATL" } },
              { homeAway: "away", team: { abbreviation: "CAR" } },
            ],
          },
        ],
      },
      {
        competitions: [
          {
            date: "2026-09-14T20:20Z",
            status: { type: { completed: false } },
            competitors: [{ homeAway: "home", team: { abbreviation: "KC" } }],
          },
        ],
      },
    ],
  });
  expect(g.get("ATL")).toEqual({ kickoff: "2026-09-14T17:00Z", completed: true });
  expect(g.get("KC")).toEqual({ kickoff: "2026-09-14T20:20Z", completed: false });
});

test("vegasImpact: higher implied total helps, weather + game script nuance by position", () => {
  const base = { impliedTotal: 27, opponentImpliedTotal: 20, spread: -2, weatherBadness: 0 };
  expect(vegasImpact({ ...base, position: "WR" })).toBeGreaterThan(0); // 27 > 22 avg
  expect(vegasImpact({ ...base, position: "WR", impliedTotal: 16 })).toBeLessThan(0);

  // Big favorite: RB up, pass-catchers down
  const fav = { impliedTotal: 24, opponentImpliedTotal: 17, spread: -9, weatherBadness: 0 };
  expect(vegasImpact({ ...fav, position: "RB" })).toBeGreaterThan(vegasImpact({ ...fav, position: "WR" }));

  // Snow crushes the kicker
  const snow = { impliedTotal: 22, opponentImpliedTotal: 22, spread: 0, weatherBadness: 2 };
  expect(vegasImpact({ ...snow, position: "K" })).toBeLessThan(-0.5);

  // DEF wants a LOW opponent total
  expect(
    vegasImpact({ position: "DEF", impliedTotal: 20, opponentImpliedTotal: 14, spread: -6, weatherBadness: 0 }),
  ).toBeGreaterThan(0);
  expect(
    vegasImpact({ position: "DEF", impliedTotal: 20, opponentImpliedTotal: 30, spread: 6, weatherBadness: 0 }),
  ).toBeLessThan(0);
});

test("vegasImpact is clamped to +-2", () => {
  const extreme = { position: "WR", impliedTotal: 60, opponentImpliedTotal: 5, spread: -20, weatherBadness: 0 };
  expect(vegasImpact(extreme)).toBe(2);
});
