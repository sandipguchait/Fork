/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describeServer } from './config.ts';
import { PROJECT_CONFIG, USER_CONFIG, type McpManager, type ServerState } from './manager.ts';

const TEMPLATE = `{
	// MCP servers for Fork's agent, in the same format as Cursor's mcp.json.
	// Local servers: "command", "args", "env". Remote servers: "url", "headers".
	// \${env:NAME}, \${workspaceFolder} and \${userHome} are filled in. Tools ask before they run
	// unless listed in "autoApprove" or allowed with Always allow.
	"mcpServers": {
		// "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "\${workspaceFolder}"] },
		// "git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "\${workspaceFolder}"] },
		// "github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer \${env:GITHUB_TOKEN}" } }
	}
}
`;

/** Opens an mcp.json, creating it from a commented template the first time. */
export async function openMcpConfig(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(TEMPLATE));
	}
	await vscode.window.showTextDocument(uri);
}

const ICONS: Record<ServerState['status'], string> = {
	ready: '$(pass-filled)',
	starting: '$(loading~spin)',
	error: '$(error)',
	stopped: '$(circle-outline)',
	disabled: '$(circle-slash)',
	untrusted: '$(shield)',
};

function summary(state: ServerState): string {
	switch (state.status) {
		case 'ready': return `${state.tools.length} tool${state.tools.length === 1 ? '' : 's'} · ${state.transport}${state.era === 'modern' ? ' · MCP 2026-07-28' : ''}`;
		case 'starting': return 'starting…';
		case 'error': return 'failed';
		case 'disabled': return 'off';
		case 'untrusted': return 'not started: waiting for you to trust it';
		default: return 'stopped';
	}
}

const RESTART = { iconPath: new vscode.ThemeIcon('debug-restart'), tooltip: 'Restart' };
const TURN_OFF = { iconPath: new vscode.ThemeIcon('circle-slash'), tooltip: 'Turn off in this workspace' };
const TURN_ON = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Turn on' };

type Item = vscode.QuickPickItem & { state?: ServerState; run?: () => unknown };

/** Fork AI: MCP Servers. Each server with its status; buttons restart or turn it off. */
export async function showMcpServers(manager: McpManager, output: vscode.OutputChannel): Promise<void> {
	const quickPick = vscode.window.createQuickPick<Item>();
	quickPick.title = 'MCP servers';
	quickPick.matchOnDetail = true;
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const refresh = () => {
		const servers = manager.servers();
		const items: Item[] = servers.map(state => ({
			label: `${ICONS[state.status]} ${state.config.name}`,
			description: `${state.config.source === 'project' ? 'project' : 'user'} · ${summary(state)}`,
			detail: state.error ?? describeServer(state.config),
			buttons: state.status === 'disabled' ? [TURN_ON] : [RESTART, TURN_OFF],
			state,
		}));
		if (!manager.enabled()) {
			items.unshift({ label: '$(circle-slash) MCP is turned off', detail: 'Settings: Companion › MCP: Enabled', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'forkAi.mcp.enabled') });
		} else if (!servers.length) {
			items.unshift({ label: 'No MCP servers yet', detail: 'Add one to ~/.fork/mcp.json (all projects) or .fork/mcp.json (this project). Cursor\'s mcp.json format works as it is.' });
		}
		for (const error of manager.errors()) {
			items.push({ label: `$(warning) ${error}` });
		}
		items.push(
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(gear) Edit user servers', description: '~/.fork/mcp.json', run: () => openMcpConfig(USER_CONFIG()) },
			...(root ? [{ label: '$(gear) Edit project servers', description: '.fork/mcp.json', run: () => openMcpConfig(PROJECT_CONFIG(root)) }] : []),
			{ label: '$(output) Show MCP log', run: () => output.show() },
		);
		quickPick.items = items;
	};
	refresh();
	const listener = manager.onDidChange(refresh);
	quickPick.onDidTriggerItemButton(async ({ item, button }) => {
		const state = item.state;
		if (!state) {
			return;
		}
		if (button === RESTART) {
			await manager.restart(state.config.name);
		} else if (button === TURN_OFF) {
			await manager.setEnabled(state.config.name, false);
		} else if (button === TURN_ON) {
			await manager.setEnabled(state.config.name, true);
		}
	});
	quickPick.onDidAccept(async () => {
		const item = quickPick.selectedItems[0];
		if (!item) {
			return;
		}
		quickPick.hide();
		if (item.run) {
			await item.run();
		} else if (item.state?.status === 'untrusted') {
			await manager.setEnabled(item.state.config.name, true);
		} else if (item.state?.status === 'ready') {
			await showTools(item.state);
		} else if (item.state?.status === 'error') {
			output.show();
		}
	});
	quickPick.onDidHide(() => {
		listener.dispose();
		quickPick.dispose();
	});
	quickPick.show();
}

async function showTools(state: ServerState): Promise<void> {
	await vscode.window.showQuickPick(
		state.tools.map(tool => ({
			label: tool.name,
			description: [tool.annotations?.readOnlyHint ? 'read-only' : '', tool.annotations?.destructiveHint ? 'destructive' : '', state.config.autoApprove.includes(tool.name) ? 'runs without asking' : ''].filter(Boolean).join(' · ') || undefined,
			detail: tool.description,
		})),
		{ title: `${state.config.name}: ${state.tools.length} tools${state.serverName ? ` (${state.serverName})` : ''}`, placeHolder: 'The agent can use these tools. Each asks before it runs unless allowed.', matchOnDetail: true },
	);
}
