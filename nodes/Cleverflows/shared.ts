/**
 * Protocol logic shared by the three Cleverflows nodes. Pure functions
 * without n8n imports so they can be unit tested (test/shared.test.js).
 *
 * Contract: Cleverflows docs, sections 6 (workflow runs) and 7.2 (agent
 * tasks); spec in integrations/SPEC.md.
 */

export type CfKind = 'workflow_run' | 'agent_task';

/** Everything a later node needs to report back to Cleverflows. */
export interface CfContext {
	protocol: 1;
	kind: CfKind;
	workspaceId: string | null;
	/** Workflow run id (kind workflow_run) */
	runId: string | null;
	/** Agent task id (kind agent_task) */
	taskId: string | null;
	callbackUrl: string | null;
	callbackToken: string | null;
	tokenHeader: string;
	templateKey: string | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Detects whether a body (start or resume) belongs to a workflow run or an agent task. */
export function detectKind(body: Obj): CfKind | null {
	const kind = str(body.kind);
	if (kind === 'agent_task_start' || kind === 'agent_capability') return 'agent_task';
	if (isObj(body.callback) || str(body.taskId) || (isObj(body.task) && isObj(body.agent))) return 'agent_task';
	if (str(body.workflowRunId) || isObj(body.workflowRun)) return 'workflow_run';
	return null;
}

/**
 * Builds the callback context from a start or resume body. `previous` fills
 * gaps (e.g. a resume body without workspaceId).
 */
export function extractContext(body: Obj, previous?: CfContext | null): CfContext | null {
	const kind = detectKind(body) ?? previous?.kind ?? null;
	if (!kind) return null;
	if (kind === 'workflow_run') {
		const run = isObj(body.workflowRun) ? body.workflowRun : {};
		const workflow = isObj(body.workflow) ? body.workflow : {};
		return {
			protocol: 1,
			kind,
			workspaceId: str(body.workspaceId) ?? previous?.workspaceId ?? null,
			runId: str(body.workflowRunId) ?? str(run.id) ?? previous?.runId ?? null,
			taskId: null,
			callbackUrl: str(body.callbackUrl) ?? previous?.callbackUrl ?? null,
			callbackToken: str(body.callbackToken) ?? previous?.callbackToken ?? null,
			tokenHeader: 'x-cleverflows-signature',
			templateKey: str(workflow.templateKey) ?? previous?.templateKey ?? null,
		};
	}
	const callback = isObj(body.callback) ? body.callback : {};
	const task = isObj(body.task) ? body.task : {};
	const agent = isObj(body.agent) ? body.agent : {};
	return {
		protocol: 1,
		kind,
		workspaceId: str(body.workspaceId) ?? previous?.workspaceId ?? null,
		runId: null,
		taskId: str(callback.taskId) ?? str(task.id) ?? str(body.taskId) ?? previous?.taskId ?? null,
		callbackUrl: str(callback.url) ?? previous?.callbackUrl ?? null,
		callbackToken: str(callback.token) ?? previous?.callbackToken ?? null,
		tokenHeader: str(callback.tokenHeader) ?? previous?.tokenHeader ?? 'x-cleverflows-signature',
		templateKey: str(agent.templateKey) ?? previous?.templateKey ?? null,
	};
}

/** Connections as a map by provider (first one wins), e.g. connectionsByProvider.wordpress.config */
function byProvider(connections: unknown[]): Obj {
	const map: Obj = {};
	for (const c of connections) {
		if (isObj(c) && typeof c.provider === 'string' && !(c.provider in map)) map[c.provider] = c;
	}
	return map;
}

/**
 * Turns a start body into clean output items. With `splitRecords` a workflow
 * run yields one item per record, each with `record` set.
 */
export function normalizeStart(body: Obj, opts: { splitRecords?: boolean; includeRaw?: boolean } = {}): Obj[] {
	const cf = extractContext(body);
	const kind = cf?.kind ?? null;
	const connections = arr(body.connections);
	const base: Obj = {
		kind,
		workspace: isObj(body.workspace) ? body.workspace : null,
		knowledge: arr(body.knowledge),
		connectionsByProvider: byProvider(connections),
		connections,
		templateKey: cf?.templateKey ?? null,
		cf,
	};
	if (opts.includeRaw) base.payload = body;

	if (kind === 'agent_task') {
		const agent = isObj(body.agent) ? body.agent : {};
		const task = isObj(body.task) ? body.task : {};
		const item: Obj = {
			...base,
			agent,
			task,
			goal: str(task.goal),
			instructions: str(agent.instructions),
			actions: arr(body.actions),
			memory: arr(body.memory),
			tables: arr(body.tables),
			capability: isObj(body.capability) ? body.capability : null,
		};
		return [item];
	}

	const workflow = isObj(body.workflow) ? body.workflow : {};
	const records = arr(body.records);
	const common: Obj = {
		...base,
		workflow,
		workflowRun: isObj(body.workflowRun) ? body.workflowRun : null,
		configValues: isObj(workflow.configValues) ? workflow.configValues : {},
		pushTarget: isObj(body.pushTarget) ? body.pushTarget : null,
	};
	if (opts.splitRecords && records.length > 1) {
		return records.map((record) => ({ ...common, record, values: isObj(record) ? record.values ?? {} : {} }));
	}
	const first = records[0];
	return [{ ...common, records, record: first ?? null, values: isObj(first) ? first.values ?? {} : {} }];
}

/** Checks the auth header Cleverflows sends (same setting as in Cleverflows → Automation). */
export function checkAuth(
	headers: Record<string, string | string[] | undefined>,
	cred: { authType?: string; headerName?: string; token?: string } | null,
): boolean {
	if (!cred || !cred.authType || cred.authType === 'none') return true;
	if (!cred.token) return false;
	const get = (name: string) => {
		const v = headers[name.toLowerCase()];
		return Array.isArray(v) ? v[0] : v;
	};
	const expected = cred.authType === 'bearer' ? `Bearer ${cred.token}` : cred.token;
	const received = cred.authType === 'bearer' ? get('authorization') : get(cred.headerName || 'X-API-Key');
	return typeof received === 'string' && timingSafeEqualStr(received, expected);
}

function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export type ReportOperation = 'progress' | 'complete' | 'fail' | 'cancel';

export interface ReportInput {
	message?: string;
	progress?: number;
	/** Result values (workflow: fields of the result record; agent: result.content) */
	values?: Obj;
	resultTitle?: string;
	resultSummary?: string;
	resultType?: string;
	errorDetails?: string;
	memory?: unknown[];
	records?: unknown[];
	executionId?: string | number | null;
}

export interface CallbackRequest {
	url: string;
	headers: Record<string, string>;
	body: Obj;
}

function requireContext(cf: CfContext | null | undefined): CfContext {
	if (!cf || !cf.kind) throw new Error('No Cleverflows context found. Connect this node after a Cleverflows Trigger or set "Cleverflows Context".');
	if (!cf.callbackUrl || !cf.callbackToken) throw new Error('The Cleverflows context has no callback URL or token. Is a callback secret set under Connections → Automation?');
	if (cf.kind === 'workflow_run' && (!cf.runId || !cf.workspaceId)) throw new Error('The Cleverflows context is missing the run id or workspace id.');
	if (cf.kind === 'agent_task' && !cf.taskId) throw new Error('The Cleverflows context is missing the task id.');
	return cf;
}

function baseRequest(cf: CfContext, body: Obj, executionId?: string | number | null): CallbackRequest {
	const ids: Obj =
		cf.kind === 'workflow_run' ? { workflowRunId: cf.runId, workspaceId: cf.workspaceId } : { taskId: cf.taskId };
	return {
		url: cf.callbackUrl as string,
		headers: { 'Content-Type': 'application/json', [cf.tokenHeader]: cf.callbackToken as string },
		body: { ...ids, ...body, ...(executionId != null && executionId !== '' ? { executionId } : {}) },
	};
}

const extras = (input: ReportInput): Obj => ({
	...(input.memory && input.memory.length ? { memory: input.memory } : {}),
	...(input.records && input.records.length ? { records: input.records } : {}),
});

/**
 * Builds the callback for a report. Returns null when the operation does not
 * exist for this kind (progress on a workflow run): there is nothing to send.
 */
export function buildReport(cf: CfContext | null | undefined, op: ReportOperation, input: ReportInput): CallbackRequest | null {
	const c = requireContext(cf);
	const message = input.message || undefined;
	if (c.kind === 'workflow_run') {
		switch (op) {
			case 'progress':
				return null;
			case 'complete':
				return baseRequest(c, { status: 'completed', message, outputValues: input.values ?? {} }, input.executionId);
			case 'fail':
				return baseRequest(c, { status: 'failed', message: message ?? 'Failed', errorDetails: input.errorDetails }, input.executionId);
			case 'cancel':
				return baseRequest(c, { status: 'cancelled', message }, input.executionId);
		}
	}
	switch (op) {
		case 'progress':
			return baseRequest(
				c,
				{ type: 'progress', message, progress: clampProgress(input.progress), ...extras(input) },
				input.executionId,
			);
		case 'complete':
			return baseRequest(
				c,
				{
					type: 'done',
					message,
					result: {
						type: input.resultType || 'report',
						title: input.resultTitle || undefined,
						summary: input.resultSummary || undefined,
						content: input.values ?? {},
					},
					...extras(input),
				},
				input.executionId,
			);
		case 'fail':
			return baseRequest(c, { type: 'failed', message: message ?? 'Failed', errorDetails: input.errorDetails, ...extras(input) }, input.executionId);
		case 'cancel':
			return baseRequest(c, { type: 'cancelled', title: message, ...extras(input) }, input.executionId);
	}
	return null;
}

function clampProgress(p: unknown): number | undefined {
	if (typeof p !== 'number' || Number.isNaN(p)) return undefined;
	return Math.max(0, Math.min(100, Math.round(p)));
}

export type WaitFor = 'review' | 'approval' | 'question';

export interface WaitInput {
	title: string;
	description?: string;
	/** Content shown to the reviewer (workflow: checkpointPayload; agent: payload / result.content) */
	payload?: Obj;
	/** Workflow: checkpoint key, unique per step (e.g. draft_review) */
	checkpointKey?: string;
	expiresInMinutes?: number;
	/** Agent approval: action key (policy in Cleverflows decides) */
	actionKey?: string;
	actionLabel?: string;
	/** Agent question: fields the human fills in */
	inputFields?: unknown[];
	resultType?: string;
	resultSummary?: string;
	memory?: unknown[];
	executionId?: string | number | null;
}

/** Callback that opens a review / approval / question and names the URL to resume on. */
export function buildWaitRequest(cf: CfContext | null | undefined, waitFor: WaitFor, resumeUrl: string, input: WaitInput): CallbackRequest {
	const c = requireContext(cf);
	if (c.kind === 'workflow_run') {
		if (waitFor !== 'review') throw new Error('Workflow runs only support "Review" (checkpoint). Approvals of actions and questions exist for agent tasks.');
		return baseRequest(
			c,
			{
				status: 'checkpoint',
				checkpointKey: input.checkpointKey || 'review',
				checkpointTitle: input.title,
				checkpointDescription: input.description || undefined,
				checkpointPayload: input.payload ?? {},
				resumeWebhookUrl: resumeUrl,
				...(input.expiresInMinutes != null ? { checkpointExpiresInMinutes: input.expiresInMinutes } : {}),
			},
			input.executionId,
		);
	}
	const common = {
		title: input.title,
		description: input.description || undefined,
		resumeWebhookUrl: resumeUrl,
		...extras({ memory: input.memory }),
	};
	if (waitFor === 'question') {
		return baseRequest(c, { type: 'question', ...common, inputFields: input.inputFields ?? [] }, input.executionId);
	}
	if (waitFor === 'approval') {
		return baseRequest(
			c,
			{ type: 'approval', ...common, actionKey: input.actionKey, actionLabel: input.actionLabel || undefined, payload: input.payload ?? {} },
			input.executionId,
		);
	}
	return baseRequest(
		c,
		{
			type: 'result',
			...common,
			payload: input.payload ?? {},
			result: { type: input.resultType || 'content', title: input.title, summary: input.resultSummary || undefined, content: input.payload ?? {} },
		},
		input.executionId,
	);
}

export type ResumeOutcome = 'approved' | 'revise' | 'rejected' | 'answered';

/** Reads the decision from a resume body (workflow: action; agent: type + decision). */
export function interpretResume(body: Obj): { outcome: ResumeOutcome; feedback: string | null; edited: Obj | null; response: Obj | null } {
	const feedback = str(body.feedback);
	const edited = isObj(body.editedPayload) ? body.editedPayload : null;
	if (body.type === 'answer') {
		return { outcome: 'answered', feedback, edited, response: isObj(body.response) ? body.response : {} };
	}
	const decision = str(body.decision) ?? str(body.action);
	if (decision === 'approve') return { outcome: 'approved', feedback, edited, response: null };
	if (decision === 'reject') return { outcome: 'rejected', feedback, edited, response: null };
	if (decision === 'revise' || decision === 'image') return { outcome: 'revise', feedback, edited, response: null };
	throw new Error(`Unknown decision in resume call: ${String(decision)}`);
}
