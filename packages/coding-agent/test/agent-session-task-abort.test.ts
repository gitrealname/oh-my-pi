import { describe, it, expect } from "bun:test";

class TaskAbortTracker {
    #controllers = new Set<AbortController>();
    get isTaskRunning() { return this.#controllers.size > 0; }
    abortTask() { for (const c of this.#controllers) c.abort(); }
    trackTaskExecution<T>(execution: Promise<T>, controller: AbortController): Promise<T> {
        this.#controllers.add(controller);
        void execution.then(
            () => this.#controllers.delete(controller),
            () => this.#controllers.delete(controller),
        );
        return execution;
    }
}

describe("AgentSession task abort tracking", () => {
    it("isTaskRunning is false initially", () => {
        const tracker = new TaskAbortTracker();
        expect(tracker.isTaskRunning).toBe(false);
    });

    it("isTaskRunning is true while task is running", () => {
        const tracker = new TaskAbortTracker();
        let resolve!: (v: void) => void;
        const p = new Promise<void>(res => { resolve = res; });
        tracker.trackTaskExecution(p, new AbortController());
        expect(tracker.isTaskRunning).toBe(true);
        resolve();
    });

    it("isTaskRunning is false after task completes", async () => {
        const tracker = new TaskAbortTracker();
        let resolve!: (v: string) => void;
        const p = new Promise<string>(res => { resolve = res; });
        tracker.trackTaskExecution(p, new AbortController());
        resolve("done");
        await p;
        // microtask queue needs to flush so the .then() cleanup runs
        await Promise.resolve();
        expect(tracker.isTaskRunning).toBe(false);
    });

    it("isTaskRunning is false after task rejects", async () => {
        const tracker = new TaskAbortTracker();
        let reject!: (e: unknown) => void;
        const p = new Promise<void>((_, rej) => { reject = rej; });
        tracker.trackTaskExecution(p, new AbortController());
        reject(new Error("boom"));
        await p.catch(() => {});
        await Promise.resolve();
        expect(tracker.isTaskRunning).toBe(false);
    });

    it("abortTask() fires the AbortController", async () => {
        const tracker = new TaskAbortTracker();
        const controller = new AbortController();
        let resolve!: (v: void) => void;
        const p = new Promise<void>(res => { resolve = res; });
        tracker.trackTaskExecution(p, controller);
        tracker.abortTask();
        expect(controller.signal.aborted).toBe(true);
        resolve();
    });

    it("abortTask() with no running tasks is a no-op", () => {
        const tracker = new TaskAbortTracker();
        expect(() => tracker.abortTask()).not.toThrow();
    });

    it("tracks multiple concurrent tasks", async () => {
        const tracker = new TaskAbortTracker();
        const resolvers: Array<() => void> = [];
        const promises = Array.from({ length: 3 }, () => {
            let resolve!: () => void;
            const p = new Promise<void>(res => { resolve = res; });
            resolvers.push(resolve);
            tracker.trackTaskExecution(p, new AbortController());
            return p;
        });
        expect(tracker.isTaskRunning).toBe(true);
        resolvers.forEach(r => r());
        await Promise.all(promises);
        await Promise.resolve();
        expect(tracker.isTaskRunning).toBe(false);
    });

    it("abortTask() aborts all concurrent tasks", () => {
        const tracker = new TaskAbortTracker();
        const controllers = Array.from({ length: 3 }, () => new AbortController());
        controllers.forEach(c => {
            const p = new Promise<void>(() => {});
            tracker.trackTaskExecution(p, c);
        });
        tracker.abortTask();
        expect(controllers.every(c => c.signal.aborted)).toBe(true);
    });

    it("trackTaskExecution returns the original promise", async () => {
        const tracker = new TaskAbortTracker();
        const p = Promise.resolve(42);
        const returned = tracker.trackTaskExecution(p, new AbortController());
        expect(returned).toBe(p);
        const value = await returned;
        expect(value).toBe(42);
    });
});
