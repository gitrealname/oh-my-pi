import { describe, expect, it } from "bun:test";
import { mapWithConcurrencyLimit } from "../src/task/parallel";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrencyLimit", () => {
	it("completes all tasks when not aborted", async () => {
		const items = [0, 1, 2, 3];
		const { results, aborted } = await mapWithConcurrencyLimit(
			items,
			2,
			async (item) => {
				await sleep(10);
				return item * 2;
			},
		);
		expect(aborted).toBe(false);
		expect(results).toEqual([0, 2, 4, 6]);
	});

	it("returns immediately on abort before any task starts", async () => {
		const controller = new AbortController();
		controller.abort();

		const started: number[] = [];
		const { results, aborted } = await mapWithConcurrencyLimit(
			[0, 1, 2],
			2,
			async (item) => {
				started.push(item);
				await sleep(100);
				return item;
			},
			controller.signal,
		);

		expect(aborted).toBe(true);
		expect(results.filter((r) => r !== undefined)).toHaveLength(0);
		expect(started).toHaveLength(0);
	});

	it("aborts in-flight task without waiting for teardown", async () => {
		const controller = new AbortController();

		const start = Date.now();
		const racePromise = mapWithConcurrencyLimit(
			[0],
			1,
			async (_item) => {
				await sleep(5000); // simulates long teardown
				return "done";
			},
			controller.signal,
		);

		// Abort after a short delay
		await sleep(50);
		controller.abort();

		const { aborted } = await racePromise;
		const elapsed = Date.now() - start;

		expect(aborted).toBe(true);
		expect(elapsed).toBeLessThan(500);
	});

	it("aborted flag false on clean completion", async () => {
		const controller = new AbortController();

		const { results, aborted } = await mapWithConcurrencyLimit(
			[1, 2, 3],
			3,
			async (item) => {
				await sleep(10);
				return item;
			},
			controller.signal,
		);

		expect(aborted).toBe(false);
		expect(results).toEqual([1, 2, 3]);
	});

	it("partial results preserved for completed tasks before abort", async () => {
		const controller = new AbortController();

		// concurrency 1: task 0 runs, completes, then task 1 starts (5s sleep), task 2 never starts
		const racePromise = mapWithConcurrencyLimit(
			["item-0", "item-1", "item-2"],
			1,
			async (item, index) => {
				if (index === 0) {
					await sleep(10);
					return `done-${index}`;
				}
				// task 1: long sleep; task 2: never reached
				await sleep(5000);
				return `done-${index}`;
			},
			controller.signal,
		);

		// Wait long enough for task 0 to finish and task 1 to start, then abort
		await sleep(100);
		controller.abort();

		const { results, aborted } = await racePromise;

		expect(aborted).toBe(true);
		expect(results[0]).toBe("done-0");
		expect(results[1]).toBeUndefined();
		expect(results[2]).toBeUndefined();
	});
});
