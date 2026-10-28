import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, WAIT_INDEFINITELY } from 'n8n-workflow';
import { buildWaitRequest, checkAuth, extractContext, interpretResume, normalizeStart, type WaitFor } from './shared';
import { cleverflowsApiTest, contextProperty, parseJsonParam, readContext, sendCallback } from './node-helpers';

// Output order per mode; must match the `outputs` expression below.
const REVIEW_OUTPUTS = ['approved', 'revise', 'rejected', 'timeout'] as const;
const QUESTION_OUTPUTS = ['answered', 'timeout'] as const;

const outputsFor = (waitFor: WaitFor): readonly string[] => (waitFor === 'question' ? QUESTION_OUTPUTS : REVIEW_OUTPUTS);

function route(waitFor: WaitFor, outcome: string, item: INodeExecutionData): INodeExecutionData[][] {
	const names = outputsFor(waitFor);
	return names.map((name) => (name === outcome ? [item] : []));
}

// Cleverflows keeps one checkpoint per key and run. After "Revise" the flow
// loops back here, so every further round gets its own key: draft_review,
// draft_review_2, draft_review_3 …
function checkpointKeyFor(ctx: IExecuteFunctions): string {
	const base = (ctx.getNodeParameter('checkpointKey', 0, 'review') as string) || 'review';
	const runIndex = Number(ctx.evaluateExpression('{{ $runIndex }}', 0)) || 0;
	return runIndex > 0 ? `${base}_${runIndex + 1}` : base;
}

export class CleverflowsWait implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cleverflows Wait',
		name: 'cleverflowsWait',
		icon: { light: 'file:cleverflows.svg', dark: 'file:cleverflows.dark.svg' },
		group: ['organization'],
		version: 1,
		subtitle: '={{ $parameter.waitFor }}',
		description: 'Send a review, approval or question to Cleverflows and wait for the answer',
		defaults: { name: 'Cleverflows Wait' },
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{ $parameter.waitFor === 'question'
			? [{ type: 'main', displayName: 'Answered' }, { type: 'main', displayName: 'Timed Out' }]
			: [{ type: 'main', displayName: 'Approved' }, { type: 'main', displayName: 'Revise' }, { type: 'main', displayName: 'Rejected' }, { type: 'main', displayName: 'Timed Out' }] }}`,
		credentials: [{ name: 'cleverflowsApi', required: true, testedBy: 'cleverflowsApiTest' }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '',
				restartWebhook: true,
			},
		],
		properties: [
			{
				displayName: 'Wait For',
				name: 'waitFor',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Review',
						value: 'review',
						description: 'Workflow run: checkpoint under Reviews. Agent task: result to check.',
					},
					{
						name: 'Approval of an Action (Agent)',
						value: 'approval',
						description: 'The rule of the action in Cleverflows decides: allowed and not allowed answer at once',
					},
					{ name: 'Question (Agent)', value: 'question', description: 'A human fills in fields' },
				],
				default: 'review',
			},
			contextProperty,
			{
				displayName: 'Title',
				name: 'title',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Check draft',
			},
			{
				displayName: 'Description',
				name: 'description',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
			},
			{
				displayName: 'Checkpoint Key',
				name: 'checkpointKey',
				type: 'string',
				default: 'review',
				description:
					'Workflow runs: one key per review step, e.g. draft_review or image_review. Further rounds after "Revise" get _2, _3 … appended.',
				displayOptions: { show: { waitFor: ['review'] } },
			},
			{
				displayName: 'Content to Review',
				name: 'payload',
				type: 'json',
				default: '{}',
				description:
					'Shown to the reviewer. Workflow runs: e.g. {"title":"…","teaser":"…","content":"…"}; edited values come back as editedPayload.',
				displayOptions: { show: { waitFor: ['review', 'approval'] } },
			},
			{
				displayName: 'Action Key',
				name: 'actionKey',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'publish',
				description: 'Key of the action as configured on the agent',
				displayOptions: { show: { waitFor: ['approval'] } },
			},
			{
				displayName: 'Input Fields',
				name: 'inputFields',
				type: 'json',
				default: '[{"key":"answer","label":"Answer","type":"text","required":true}]',
				displayOptions: { show: { waitFor: ['question'] } },
			},
			{
				displayName: 'Limit Wait Time',
				name: 'limitWaitTime',
				type: 'boolean',
				default: true,
				description:
					'Whether to stop waiting after a while and continue on "Timed Out". Cleverflows also expires open requests (reviews after 24 h by default).',
			},
			{
				displayName: 'Max Wait (Hours)',
				name: 'maxHours',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 168,
				displayOptions: { show: { limitWaitTime: [true] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Review Expires After (Minutes, Workflow)',
						name: 'expiresInMinutes',
						type: 'number',
						default: 1440,
						description: '0 = never. Overrides the default of the workflow.',
					},
					{
						displayName: 'Action Label (Agent)',
						name: 'actionLabel',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Result Type (Agent Review)',
						name: 'resultType',
						type: 'options',
						options: [
							{ name: 'Content', value: 'content' },
							{ name: 'List', value: 'list' },
							{ name: 'Report', value: 'report' },
						],
						default: 'content',
					},
					{
						displayName: 'Memory (Agent)',
						name: 'memory',
						type: 'json',
						default: '[]',
					},
				],
			},
		],
		usableAsTool: true,
	};

	methods = { credentialTest: { cleverflowsApiTest } };

	// Resume URL is created per execution by n8n, nothing to register remotely
	webhookMethods = {
		default: {
			async checkExists(): Promise<boolean> {
				return true;
			},
			async create(): Promise<boolean> {
				return true;
			},
			async delete(): Promise<boolean> {
				return true;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (items.length !== 1) {
			throw new NodeOperationError(
				this.getNode(),
				`Cleverflows Wait handles one item at a time (got ${items.length}). Aggregate or loop before this node.`,
			);
		}
		const item = items[0];
		const waitFor = this.getNodeParameter('waitFor', 0) as WaitFor;
		const cf = readContext(this, 0, item);
		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0) as string;

		const req = buildWaitRequest(cf, waitFor, resumeUrl, {
			title: this.getNodeParameter('title', 0) as string,
			description: this.getNodeParameter('description', 0, '') as string,
			checkpointKey: waitFor === 'review' ? checkpointKeyFor(this) : undefined,
			payload:
				waitFor === 'question' ? undefined : (parseJsonParam(this, this.getNodeParameter('payload', 0, '{}'), 'Content to Review', 0) as IDataObject),
			actionKey: waitFor === 'approval' ? (this.getNodeParameter('actionKey', 0) as string) : undefined,
			actionLabel: options.actionLabel as string | undefined,
			inputFields:
				waitFor === 'question' ? (parseJsonParam(this, this.getNodeParameter('inputFields', 0), 'Input Fields', 0) as unknown[]) : undefined,
			expiresInMinutes: options.expiresInMinutes as number | undefined,
			resultType: options.resultType as string | undefined,
			memory: options.memory ? (parseJsonParam(this, options.memory, 'Memory', 0) as unknown[]) : undefined,
			executionId: this.getExecutionId(),
		});
		const response = (await sendCallback(this, req, 0)) as IDataObject;

		// Approvals of actions with rule "allowed" / "not allowed" are decided at once
		if (waitFor === 'approval' && (response?.decision === 'approved' || response?.decision === 'rejected')) {
			const outcome = response.decision === 'approved' ? 'approved' : 'rejected';
			return route(waitFor, outcome, {
				json: { ...item.json, decision: outcome, decidedBy: 'rule', reason: response.reason ?? null },
				pairedItem: { item: 0 },
			});
		}

		const limit = this.getNodeParameter('limitWaitTime', 0) as boolean;
		const waitTill = limit
			? new Date(Date.now() + (this.getNodeParameter('maxHours', 0) as number) * 3600_000)
			: WAIT_INDEFINITELY;
		await this.putExecutionToWait(waitTill);
		// Only used when the wait time runs out without an answer
		return route(waitFor, 'timeout', { json: { ...item.json, decision: 'timeout' }, pairedItem: { item: 0 } });
	}

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const res = this.getResponseObject();
		const cred = (await this.getCredentials('cleverflowsApi')) as IDataObject;
		if (!checkAuth(this.getHeaderData() as Record<string, string>, cred as never)) {
			res.status(401).json({ error: 'Unauthorized' });
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData() as IDataObject;
		const waitFor = this.getNodeParameter('waitFor') as WaitFor;
		let decision;
		try {
			decision = interpretResume(body);
		} catch (error) {
			res.status(400).json({ error: (error as Error).message });
			return { noWebhookResponse: true };
		}
		const [base] = normalizeStart(body);
		const json: IDataObject = {
			...(base as IDataObject),
			cf: extractContext(body) as unknown as IDataObject,
			decision: decision.outcome,
			feedback: decision.feedback,
			editedPayload: decision.edited,
			answers: decision.response,
			originalPayload: (body.originalPayload as IDataObject) ?? null,
			resume: body,
		};
		const outcome = waitFor === 'question' ? 'answered' : decision.outcome;
		return {
			webhookResponse: { ok: true },
			workflowData: route(waitFor, outcome, { json }),
		};
	}
}
