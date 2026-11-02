/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Messages between the chat webview and the extension host. Shared by both sides.

export interface ModelOption {
	readonly id: string;
	readonly name: string;
	readonly detail: string;
}

export interface ContextChip {
	readonly id: string;
	readonly label: string;
	readonly title: string;
	readonly kind: 'current' | 'file' | 'selection';
}

export interface TurnView {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly chips?: readonly string[];
	readonly error?: string;
	readonly modelName?: string;
}

export interface ChatState {
	readonly models: readonly ModelOption[];
	readonly selectedModelId: string | undefined;
	readonly turns: readonly TurnView[];
	/** The open file, offered as context; undefined when no file is open or the user removed it. */
	readonly currentFile: ContextChip | undefined;
	readonly currentFileExcluded: boolean;
	readonly attachments: readonly ContextChip[];
	readonly busy: boolean;
	readonly streamingTurnId: string | undefined;
}

export type ToWebview =
	| { readonly type: 'state'; readonly state: ChatState }
	| { readonly type: 'delta'; readonly turnId: string; readonly text: string }
	| { readonly type: 'focusInput' };

export type FromWebview =
	| { readonly type: 'ready' }
	| { readonly type: 'send'; readonly text: string }
	| { readonly type: 'stop' }
	| { readonly type: 'selectModel'; readonly id: string }
	| { readonly type: 'addModel' }
	| { readonly type: 'manageModels' }
	| { readonly type: 'attachFile' }
	| { readonly type: 'removeAttachment'; readonly id: string }
	| { readonly type: 'toggleCurrentFile' }
	| { readonly type: 'copyCode'; readonly code: string }
	| { readonly type: 'insertCode'; readonly code: string }
	| { readonly type: 'applyCode'; readonly code: string }
	| { readonly type: 'newChat' };
