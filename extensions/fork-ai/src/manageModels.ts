/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { addModel, changeKey, retestModel } from './addModel.ts';
import type { ModelStore, StoredModel } from './modelStore.ts';
import { API_FORMAT_LABELS } from './presets.ts';

interface ModelItem extends vscode.QuickPickItem {
	readonly model?: StoredModel;
}

const TEST = { iconPath: new vscode.ThemeIcon('beaker'), tooltip: 'Test connection' };
const KEY = { iconPath: new vscode.ThemeIcon('key'), tooltip: 'Change API key' };
const REMOVE = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove model' };

export function modelDetail(model: StoredModel): string {
	let host = model.baseUrl;
	try {
		host = new URL(model.baseUrl).host;
	} catch {
		// Shown as typed.
	}
	return `${model.model} · ${host} · ${API_FORMAT_LABELS[model.apiFormat].label}${model.hasKey ? '' : ' · no key'}`;
}

/** Fork AI: Manage Models. Pick a model to use it for chat; buttons test, re-key or remove it. */
export async function manageModels(store: ModelStore): Promise<void> {
	const quickPick = vscode.window.createQuickPick<ModelItem>();
	quickPick.title = 'Models';
	quickPick.placeholder = 'Pick a model to use for chat';
	quickPick.matchOnDetail = true;

	const refresh = () => {
		const chatId = store.chatModelId();
		quickPick.items = [
			...store.list().map((model): ModelItem => ({
				label: `${model.id === chatId ? '$(check) ' : ''}${model.displayName}`,
				description: model.id === chatId ? 'chat model' : undefined,
				detail: modelDetail(model),
				buttons: [TEST, KEY, REMOVE],
				model,
			})),
			{ label: '', kind: vscode.QuickPickItemKind.Separator },
			{ label: '$(add) Add model…', alwaysShow: true },
		];
	};
	refresh();
	const listener = store.onDidChange(refresh);

	quickPick.onDidTriggerItemButton(async ({ item, button }) => {
		const model = item.model;
		if (!model) {
			return;
		}
		if (button === TEST) {
			await retestModel(store, model.id);
		} else if (button === KEY) {
			await changeKey(store, model.id);
		} else if (button === REMOVE) {
			const answer = await vscode.window.showWarningMessage(`Remove ${model.displayName}? Its API key is deleted from the keychain.`, { modal: true }, 'Remove');
			if (answer === 'Remove') {
				await store.remove(model.id);
			}
		}
	});

	quickPick.onDidAccept(async () => {
		const item = quickPick.selectedItems[0];
		quickPick.hide();
		if (item?.model) {
			await store.setChatModel(item.model.id);
		} else if (item) {
			await addModel(store);
		}
	});

	quickPick.onDidHide(() => {
		listener.dispose();
		quickPick.dispose();
	});
	quickPick.show();
}
