// Unit tests for the protocol logic (run: npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../dist/nodes/Cleverflows/shared.js');

const runStart = {
	workspaceId: 'ws1',
	workflowRunId: 'run1',
	records: [
		{ id: 'r1', values: { topic: 'A' } },
		{ id: 'r2', values: { topic: 'B' } },
	],
	workflow: { key: 'blog', templateKey: 'seo_blogpost', configValues: { tone: 'du' } },
	workflowRun: { id: 'run1', attemptNumber: 1 },
	callbackUrl: 'https://cf.test/api/integrations/n8n/callback',
	callbackToken: 'tok-run',
	knowledge: [{ kind: 'rule' }],
	resumeWebhookUrl: 'https://n8n.test/webhook/blog-resume',
};

const taskStart = {
	protocolVersion: 1,
	kind: 'agent_task_start',
	workspaceId: 'ws1',
	agent: { id: 'a1', templateKey: 'seo', instructions: 'Be brief' },
	task: { id: 't1', goal: 'Audit' },
	actions: [{ key: 'publish', policy: 'approval' }],
	memory: [],
	connections: [{ provider: 'wordpress', config: { url: 'x' } }, { provider: 'wordpress', config: { url: 'y' } }],
	callback: { url: 'https://cf.test/api/integrations/n8n/agent-callback', taskId: 't1', token: 'tok-task', tokenHeader: 'x-cleverflows-signature' },
};

test('detects kinds', () => {
	assert.equal(s.detectKind(runStart), 'workflow_run');
	assert.equal(s.detectKind(taskStart), 'agent_task');
	assert.equal(s.detectKind({ kind: 'agent_capability', task: { id: 't' } }), 'agent_task');
	assert.equal(s.detectKind({ foo: 1 }), null);
});

test('normalizes a workflow run', () => {
	const [item] = s.normalizeStart(runStart);
	assert.equal(item.kind, 'workflow_run');
	assert.equal(item.record.id, 'r1');
	assert.deepEqual(item.values, { topic: 'A' });
	assert.deepEqual(item.configValues, { tone: 'du' });
	assert.equal(item.cf.runId, 'run1');
	assert.equal(item.cf.callbackToken, 'tok-run');
	assert.equal(item.templateKey, 'seo_blogpost');
	assert.equal(item.payload, undefined);
	const split = s.normalizeStart(runStart, { splitRecords: true, includeRaw: true });
	assert.equal(split.length, 2);
	assert.equal(split[1].record.id, 'r2');
	assert.equal(split[1].payload, runStart);
});

test('normalizes an agent task', () => {
	const [item] = s.normalizeStart(taskStart);
	assert.equal(item.kind, 'agent_task');
	assert.equal(item.goal, 'Audit');
	assert.equal(item.connectionsByProvider.wordpress.config.url, 'x');
	assert.equal(item.cf.taskId, 't1');
	assert.equal(item.cf.tokenHeader, 'x-cleverflows-signature');
});

test('checks auth header', () => {
	assert.equal(s.checkAuth({ 'x-api-key': 'k' }, { authType: 'api_key', headerName: 'X-API-Key', token: 'k' }), true);
	assert.equal(s.checkAuth({ 'x-api-key': 'no' }, { authType: 'api_key', headerName: 'X-API-Key', token: 'k' }), false);
	assert.equal(s.checkAuth({}, { authType: 'api_key', token: 'k' }), false);
	assert.equal(s.checkAuth({ authorization: 'Bearer k' }, { authType: 'bearer', token: 'k' }), true);
	assert.equal(s.checkAuth({}, { authType: 'none' }), true);
	assert.equal(s.checkAuth({}, { authType: 'api_key', token: '' }), false);
});

test('builds workflow reports', () => {
	const cf = s.extractContext(runStart);
	const done = s.buildReport(cf, 'complete', { values: { title: 'T' }, executionId: '42' });
	assert.equal(done.url, runStart.callbackUrl);
	assert.equal(done.headers['x-cleverflows-signature'], 'tok-run');
	assert.deepEqual(done.body, { workflowRunId: 'run1', workspaceId: 'ws1', status: 'completed', message: undefined, outputValues: { title: 'T' }, executionId: '42' });
	assert.equal(s.buildReport(cf, 'progress', { progress: 10 }), null);
	assert.equal(s.buildReport(cf, 'fail', { errorDetails: 'x' }).body.status, 'failed');
	assert.equal(s.buildReport(cf, 'cancel', {}).body.status, 'cancelled');
});

test('builds agent reports', () => {
	const cf = s.extractContext(taskStart);
	const p = s.buildReport(cf, 'progress', { progress: 140, memory: [{ kind: 'observation', summary: 'm' }] });
	assert.deepEqual(p.body, { taskId: 't1', type: 'progress', message: undefined, progress: 100, memory: [{ kind: 'observation', summary: 'm' }] });
	const d = s.buildReport(cf, 'complete', { values: { rows: [] }, resultTitle: 'Audit', resultType: 'list' });
	assert.equal(d.body.type, 'done');
	assert.deepEqual(d.body.result, { type: 'list', title: 'Audit', summary: undefined, content: { rows: [] } });
	assert.equal(s.buildReport(cf, 'cancel', { message: 'nothing to do' }).body.title, 'nothing to do');
});

test('rejects missing context', () => {
	assert.throws(() => s.buildReport(null, 'complete', {}), /No Cleverflows context/);
	assert.throws(() => s.buildReport({ ...s.extractContext(taskStart), callbackToken: null }, 'complete', {}), /callback URL or token/);
});

test('builds wait requests', () => {
	const run = s.extractContext(runStart);
	const cp = s.buildWaitRequest(run, 'review', 'https://n8n.test/webhook-waiting/9?signature=s', { title: 'Check', payload: { content: 'x' }, checkpointKey: 'draft', expiresInMinutes: 0 });
	assert.equal(cp.body.status, 'checkpoint');
	assert.equal(cp.body.checkpointKey, 'draft');
	assert.equal(cp.body.resumeWebhookUrl, 'https://n8n.test/webhook-waiting/9?signature=s');
	assert.equal(cp.body.checkpointExpiresInMinutes, 0);
	assert.throws(() => s.buildWaitRequest(run, 'question', 'u', { title: 'Q' }), /only support "Review"/);

	const task = s.extractContext(taskStart);
	const ap = s.buildWaitRequest(task, 'approval', 'u', { title: 'Publish?', actionKey: 'publish', payload: { a: 1 } });
	assert.equal(ap.body.type, 'approval');
	assert.equal(ap.body.actionKey, 'publish');
	assert.equal(s.buildWaitRequest(task, 'question', 'u', { title: 'Q', inputFields: [{ key: 'a' }] }).body.type, 'question');
	const rv = s.buildWaitRequest(task, 'review', 'u', { title: 'Result', payload: { c: 1 } });
	assert.equal(rv.body.type, 'result');
	assert.deepEqual(rv.body.result.content, { c: 1 });
});

test('interprets resume bodies', () => {
	assert.equal(s.interpretResume({ action: 'approve', decision: 'approve' }).outcome, 'approved');
	assert.equal(s.interpretResume({ action: 'image' }).outcome, 'revise');
	const r = s.interpretResume({ type: 'decision', decision: 'revise', feedback: 'shorter', editedPayload: { t: 1 } });
	assert.equal(r.outcome, 'revise');
	assert.equal(r.feedback, 'shorter');
	assert.equal(s.interpretResume({ type: 'decision', decision: 'reject' }).outcome, 'rejected');
	assert.deepEqual(s.interpretResume({ type: 'answer', response: { a: '1' } }).response, { a: '1' });
	assert.throws(() => s.interpretResume({}), /Unknown decision/);
});

test('resume body yields a fresh context', () => {
	const resume = { workflowRunId: 'run1', workspaceId: 'ws1', action: 'approve', callbackUrl: 'https://cf.test/cb', callbackToken: 'tok2', records: [] };
	const cf = s.extractContext(resume);
	assert.equal(cf.kind, 'workflow_run');
	assert.equal(cf.callbackToken, 'tok2');
});
