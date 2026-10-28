import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type { CallbackRequest, CfContext } from './shared';

/** Where the action and wait nodes find the callback context. */
export const contextProperty: INodeProperties = {
	displayName: 'Cleverflows Context',
	name: 'context',
	type: 'json',
	default: '={{ $json.cf }}',
	description: 'The "cf" object from the Cleverflows Trigger. If nodes in between replace the item, use e.g. {{ $(\'Cleverflows Trigger\').item.JSON.cf }}.',
};

export function parseJsonParam(ctx: IExecuteFunctions, value: unknown, label: string, itemIndex: number): unknown {
	if (typeof value !== 'string') return value;
	if (value.trim() === '') return undefined;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} is not valid JSON`, { itemIndex });
	}
}

export function readContext(ctx: IExecuteFunctions, itemIndex: number, item: INodeExecutionData): CfContext | null {
	const raw = parseJsonParam(ctx, ctx.getNodeParameter('context', itemIndex, null), 'Cleverflows Context', itemIndex);
	if (raw && typeof raw === 'object') return raw as CfContext;
	const fromItem = (item.json as IDataObject).cf;
	return fromItem && typeof fromItem === 'object' ? (fromItem as unknown as CfContext) : null;
}

export async function sendCallback(ctx: IExecuteFunctions, req: CallbackRequest, itemIndex: number): Promise<unknown> {
	try {
		return await ctx.helpers.httpRequest({
			method: 'POST',
			url: req.url,
			headers: req.headers,
			body: req.body,
			json: true,
		});
	} catch (error) {
		throw new NodeApiError(ctx.getNode(), error as never, {
			itemIndex,
			message: 'Cleverflows did not accept the callback',
		});
	}
}

// Inbound credential: there is nothing to call, so only check that a token is set.
// Cleverflows sends the same value with every start and resume, the nodes compare it.
export async function cleverflowsApiTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const data = credential.data ?? {};
	if (data.authType !== 'none' && !data.token) {
		return { status: 'Error', message: 'Token is missing' };
	}
	return { status: 'OK', message: 'Saved. Cleverflows sends this value with every start and resume.' };
}
