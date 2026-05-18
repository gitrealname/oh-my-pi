/**
 * Ambient module stub for @opentelemetry/api v1.9.x.
 *
 * This file exists because the real @opentelemetry/api package is declared in
 * bun.lock but not yet installed in node_modules (requires `bun install` after
 * the merge/v15.1.3 merge). Once installed, the real package types take
 * precedence and this stub becomes inert.
 *
 * Provides exactly the symbols used in packages/agent/src/telemetry.ts and
 * packages/agent/src/run-collector.ts.
 */

declare module "@opentelemetry/api" {
	export type AttributeValue =
		| string
		| number
		| boolean
		| Array<string>
		| Array<number>
		| Array<boolean>;

	export type Attributes = Record<string, AttributeValue | undefined>;

	export interface SpanContext {
		traceId: string;
		spanId: string;
		traceFlags: number;
		traceState?: TraceState;
		isRemote?: boolean;
	}

	export interface TraceState {
		set(key: string, value: string): TraceState;
		unset(key: string): TraceState;
		get(key: string): string | undefined;
		serialize(): string;
	}

	export interface SpanStatus {
		code: SpanStatusCode;
		message?: string;
	}

	export enum SpanStatusCode {
		UNSET = 0,
		OK = 1,
		ERROR = 2,
	}

	export enum SpanKind {
		INTERNAL = 0,
		SERVER = 1,
		CLIENT = 2,
		PRODUCER = 3,
		CONSUMER = 4,
	}

	export interface Span {
		spanContext(): SpanContext;
		setAttribute(key: string, value: AttributeValue): this;
		setAttributes(attributes: Attributes): this;
		addEvent(name: string, attributesOrStartTime?: Attributes | number, startTime?: number): this;
		setStatus(status: SpanStatus): this;
		updateName(name: string): this;
		end(endTime?: number): void;
		isRecording(): boolean;
		recordException(exception: unknown, time?: number): void;
	}

	export interface Tracer {
		startSpan(name: string, options?: SpanOptions, context?: Context): Span;
		startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
		startActiveSpan<F extends (span: Span) => unknown>(
			name: string,
			options: SpanOptions,
			fn: F,
		): ReturnType<F>;
		startActiveSpan<F extends (span: Span) => unknown>(
			name: string,
			options: SpanOptions,
			context: Context,
			fn: F,
		): ReturnType<F>;
	}

	export interface SpanOptions {
		kind?: SpanKind;
		attributes?: Attributes;
		links?: Link[];
		startTime?: number;
		root?: boolean;
	}

	export interface Link {
		context: SpanContext;
		attributes?: Attributes;
	}

	export interface Context {
		getValue(key: symbol): unknown;
		setValue(key: symbol, value: unknown): Context;
		deleteValue(key: symbol): Context;
	}

	export interface ContextManager {
		active(): Context;
		with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
			context: Context,
			fn: F,
			thisArg?: ThisParameterType<F>,
			...args: A
		): ReturnType<F>;
		bind<T>(context: Context, target: T): T;
		enable(): this;
		disable(): this;
	}

	export interface TracerProvider {
		getTracer(name: string, version?: string): Tracer;
	}

	export declare const context: {
		active(): Context;
		with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
			context: Context,
			fn: F,
			thisArg?: ThisParameterType<F>,
			...args: A
		): ReturnType<F>;
		bind<T>(context: Context, target: T): T;
		setGlobalContextManager(contextManager: ContextManager): boolean;
	};

	export declare const trace: {
		getTracer(name: string, version?: string): Tracer;
		getTracerProvider(): TracerProvider;
		setGlobalTracerProvider(provider: TracerProvider): boolean;
		getSpan(context: Context): Span | undefined;
		getActiveSpan(): Span | undefined;
		setSpan(context: Context, span: Span): Context;
		deleteSpan(context: Context): Context;
		wrapSpanContext(spanContext: SpanContext): Span;
		isSpanContextValid(spanContext: SpanContext): boolean;
	};
}
