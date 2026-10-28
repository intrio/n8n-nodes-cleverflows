import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { buildReport, type CfContext, type ReportOperation } from './shared';
import { contextProperty, parseJsonParam, readContext, sendCallback } from './node-helpers';

const show = (operation: ReportOperation[]) => ({ displayOptions: { show: { operation } } });

const resultProperties: INodeProperties[] = [
	{
		displayName: 'Result From',
		name: 'resultSource',
		type: 'options',
		options: [
			{ name: 'Fields Below', value: 'fields' },
			{ name: 'JSON', value: 'json' },
		],
		default: 'fields',
		...show(['complete']),
	},
	{
		displayName: 'Result Fields',
		name: 'resultFields',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Field',
		default: {},
		description:
			'Workflow run: field keys of the result table in Cleverflows. Agent task: content of the result.',
		displayOptions: { show: { operation: ['complete'], resultSource: ['fields'] } },
		options: [
			{
				name: 'field',
				displayName: 'Field',
				values: [
					{ displayName: 'Key', name: 'key', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'string', default: '' },
				],
			},
		],
	},
	{
		displayName: 'Result JSON',
		name: 'resultJson',
		type: 'json',
		default: '{}',
		description: 'Object with the result values, e.g. {{ $JSON.article }}',
		displayOptions: { show: { operation: ['complete'], resultSource: ['json'] } },
	},
];

export class Cleverflows implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cleverflows',
		name: 'cleverflows',
		icon: { light: 'file:cleverflows.svg', dark: 'file:cleverflows.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{ $parameter.operation }}',
		description: 'Report progress, results and errors of a run or task to Cleverflows',
		defaults: { name: 'Cleverflows' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Report Progress',
						value: 'progress',
						action: 'Report progress',
						description: 'Agent tasks: progress 0–100 and memory. Workflow runs: passes through.',
					},
					{ name: 'Complete', value: 'complete', action: 'Complete with result', description: 'Deliver the result and finish' },
					{ name: 'Fail', value: 'fail', action: 'Report an error' },
					{ name: 'Cancel', value: 'cancel', action: 'Cancel without error', description: 'Ends deliberately, e.g. nothing to do' },
				],
				default: 'complete',
			},
			contextProperty,
			{
				displayName: 'Message',
				name: 'message',
				type: 'string',
				default: '',
				description: 'Short text shown in the history in Cleverflows',
			},
			{
				displayName: 'Progress (%)',
				name: 'progress',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 100 },
				default: 50,
				...show(['progress']),
			},
			...resultProperties,
			{
				displayName: 'Error Details',
				name: 'errorDetails',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				...show(['fail']),
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Memory (Agent)',
						name: 'memory',
						type: 'json',
						default: '[]',
						description:
							'Observations or learned rules, e.g. [{"key":"tone","kind":"observation","summary":"…"}]. "key" is required; learned rules (kind learned_rule) arrive as suggestions.',
					},
					{
						displayName: 'Records (Agent)',
						name: 'records',
						type: 'json',
						default: '[]',
						description: 'Records for tables granted to the agent; they arrive for approval',
					},
					{
						displayName: 'Result Summary (Agent)',
						name: 'resultSummary',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Result Title (Agent)',
						name: 'resultTitle',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Result Type (Agent)',
						name: 'resultType',
						type: 'options',
						options: [
							{ name: 'Content', value: 'content' },
							{ name: 'List', value: 'list' },
							{ name: 'Report', value: 'report' },
						],
						default: 'report',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const executionId = this.getExecutionId();

		for (let i = 0; i < items.length; i++) {
			try {
				const op = this.getNodeParameter('operation', i) as ReportOperation;
				const cf: CfContext | null = readContext(this, i, items[i]);
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				let values: IDataObject | undefined;
				if (op === 'complete') {
					const source = this.getNodeParameter('resultSource', i) as string;
					if (source === 'json') {
						values = parseJsonParam(this, this.getNodeParameter('resultJson', i), 'Result JSON', i) as IDataObject;
					} else {
						const fields = (this.getNodeParameter('resultFields', i, {}) as IDataObject).field as
							| Array<{ key: string; value: unknown }>
							| undefined;
						values = Object.fromEntries((fields ?? []).filter((f) => f.key).map((f) => [f.key, f.value])) as IDataObject;
					}
				}
				const req = buildReport(cf, op, {
					message: this.getNodeParameter('message', i, '') as string,
					progress: op === 'progress' ? (this.getNodeParameter('progress', i) as number) : undefined,
					values,
					errorDetails: op === 'fail' ? (this.getNodeParameter('errorDetails', i, '') as string) : undefined,
					resultTitle: options.resultTitle as string | undefined,
					resultSummary: options.resultSummary as string | undefined,
					resultType: options.resultType as string | undefined,
					memory: options.memory ? (parseJsonParam(this, options.memory, 'Memory', i) as unknown[]) : undefined,
					records: options.records ? (parseJsonParam(this, options.records, 'Records', i) as unknown[]) : undefined,
					executionId,
				});
				const response = req ? await sendCallback(this, req, i) : { skipped: 'Workflow runs have no progress callback' };
				out.push({ json: { ...items[i].json, cfResponse: response as IDataObject }, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { ...items[i].json, error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
