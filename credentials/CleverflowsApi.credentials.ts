import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * The secret Cleverflows sends with every call to this automation platform
 * (start, resume). It is configured per agency under
 * Connections → Automation in Cleverflows. The trigger and the wait node
 * use it to reject calls that do not come from Cleverflows.
 */
export class CleverflowsApi implements ICredentialType {
	name = 'cleverflowsApi';

	displayName = 'Cleverflows API';

	icon: Icon = { light: 'file:cleverflows.svg', dark: 'file:cleverflows.dark.svg' };

	documentationUrl = 'https://github.com/intrio/n8n-nodes-cleverflows#readme';

	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authType',
			type: 'options',
			options: [
				{ name: 'API Key Header', value: 'api_key' },
				{ name: 'Bearer Token', value: 'bearer' },
				{ name: 'None (Not Recommended)', value: 'none' },
			],
			default: 'api_key',
			description: 'Same setting as "Auth" under Connections → Automation in Cleverflows',
		},
		{
			displayName: 'Header Name',
			name: 'headerName',
			type: 'string',
			default: 'X-API-Key',
			displayOptions: { show: { authType: ['api_key'] } },
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { authType: ['api_key', 'bearer'] } },
			description: 'The token Cleverflows sends to your automation platform',
		},
	];
}
