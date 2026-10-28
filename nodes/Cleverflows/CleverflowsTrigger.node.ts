import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { checkAuth, detectKind, normalizeStart } from './shared';
import { cleverflowsApiTest } from './node-helpers';

export class CleverflowsTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cleverflows Trigger',
		name: 'cleverflowsTrigger',
		icon: { light: 'file:cleverflows.svg', dark: 'file:cleverflows.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ "Path: " + $parameter.path }}',
		description: 'Starts when Cleverflows sends a workflow run or an agent task',
		defaults: { name: 'Cleverflows Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'cleverflowsApi', required: true, testedBy: 'cleverflowsApiTest' }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '={{$parameter["path"]}}',
				isFullPath: true,
			},
		],
		properties: [
			{
				displayName:
					'Enter the production URL of this node as webhook in Cleverflows (workflow settings, agent configuration, or the agency default under Connections → Automation). Reviews and approvals are handled by the "Cleverflows Wait" node, no second webhook needed.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: 'cleverflows',
				required: true,
				description: 'Last part of the webhook URL',
			},
			{
				displayName: 'Accept',
				name: 'accept',
				type: 'options',
				options: [
					{ name: 'Workflow Runs and Agent Tasks', value: 'all' },
					{ name: 'Workflow Runs Only', value: 'workflow_run' },
					{ name: 'Agent Tasks Only', value: 'agent_task' },
				],
				default: 'all',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'One Item per Record',
						name: 'splitRecords',
						type: 'boolean',
						default: false,
						description: 'Whether a workflow run with several records yields one item per record',
					},
					{
						displayName: 'Include Raw Payload',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description: 'Whether to add the unchanged body as "payload"',
					},
				],
			},
		],
	};

	methods = { credentialTest: { cleverflowsApiTest } };

	// The webhook URL is entered in Cleverflows by hand, nothing to register remotely
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

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const res = this.getResponseObject();
		const cred = (await this.getCredentials('cleverflowsApi')) as IDataObject;
		if (!checkAuth(this.getHeaderData() as Record<string, string>, cred as never)) {
			res.status(401).json({ error: 'Unauthorized' });
			return { noWebhookResponse: true };
		}
		const body = this.getBodyData() as IDataObject;
		const kind = detectKind(body);
		if (!kind) {
			res.status(400).json({ error: 'Not a Cleverflows run or task' });
			return { noWebhookResponse: true };
		}
		const accept = this.getNodeParameter('accept', 'all') as string;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const items = normalizeStart(body, {
			splitRecords: Boolean(options.splitRecords),
			includeRaw: Boolean(options.includeRaw),
		});
		if (accept !== 'all' && accept !== kind) {
			// 422 so Cleverflows marks the start as failed instead of waiting for a callback
			res.status(422).json({ error: `This flow does not accept ${kind}` });
			return { noWebhookResponse: true };
		}
		return {
			webhookResponse: { ok: true },
			workflowData: [this.helpers.returnJsonArray(items as IDataObject[])],
		};
	}
}
