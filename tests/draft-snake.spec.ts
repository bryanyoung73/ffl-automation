import { test, expect } from "@playwright/test";
import {
  mySlots,
  picksUntilNext,
  picksUntilAfter,
  nextPick,
} from "../src/draft/live/snake.js";

test("mySlots walks the snake — odd rounds forward, even rounds back", () => {
  expect(mySlots(1, 10, 3)).toEqual([1, 20, 21]);
  expect(mySlots(10, 10, 3)).toEqual([10, 11, 30]);
  expect(mySlots(4, 12, 5)).toEqual([4, 21, 28, 45, 52]);
});

test("mySlots returns one pick per round", () => {
  const slots = mySlots(7, 10, 16);
  expect(slots).toHaveLength(16);
  expect(slots[0]).toBe(7);
  expect(slots[1]).toBe(14); // round 2: 20 - 7 + 1
});

test("mySlots rejects an out-of-range slot", () => {
  expect(() => mySlots(0, 10, 3)).toThrow(/out of range/);
  expect(() => mySlots(11, 10, 3)).toThrow(/out of range/);
});

test("picksUntilNext counts the gap, 0 means on the clock", () => {
  const mine = mySlots(4, 12, 5); // [4, 21, 28, 45, 52]
  expect(picksUntilNext(3, mine)).toBe(0); // pick 4 is next and it's mine
  expect(picksUntilNext(4, mine)).toBe(16); // 21 - 4 - 1
  expect(picksUntilNext(20, mine)).toBe(0); // pick 21 next, mine
  expect(picksUntilNext(52, mine)).toBeNull(); // nothing left
});

test("picksUntilAfter looks one turn beyond", () => {
  const mine = mySlots(4, 12, 5);
  expect(picksUntilAfter(3, mine)).toBe(17); // second upcoming is 21 -> 21 - 3 - 1
  expect(picksUntilAfter(21, mine)).toBe(23); // upcoming [28, 45, 52], second is 45 -> 45 - 21 - 1
  expect(picksUntilAfter(45, mine)).toBeNull(); // only 52 left
});

test("nextPick returns the overall number of my next pick", () => {
  const mine = mySlots(4, 12, 5);
  expect(nextPick(3, mine)).toBe(4);
  expect(nextPick(4, mine)).toBe(21);
  expect(nextPick(52, mine)).toBeNull();
});
