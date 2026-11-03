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
	readonly kind: 'current' | 'file' | 'selection' | 'codebase';
}

export interface StepView {
	readonly id: string;
	readonly kind: 'text' | 'tool';
	readonly text: string;
	readonly status?: 'running' | 'done' | 'error' | 'skipped' | 'awaiting';
	readonly detail?: string;
	/** Present while the step waits for Run / Skip. */
	readonly approval?: { readonly command: string; readonly allowAlways: boolean };
}

export interface ChangeView {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly created: boolean;
}

export interface TurnView {
	readonly id: string;
	readonly role: 'user' | 'assistant';
	readonly text: string;
	readonly chips?: readonly string[];
	readonly error?: string;
	readonly modelName?: string;
	/** Agent turns: text and tool steps in order. */
	readonly steps?: readonly StepView[];
	readonly changes?: readonly ChangeView[];
	/** Undo is possible while the checkpoint is still in memory. */
	readonly canUndo?: boolean;
	readonly undone?: boolean;
}

export type ChatMode = 'ask' | 'agent';

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
	readonly mode: ChatMode;
	/** Shown above the input in agent mode: no folder open, or a model that failed the tool test. */
	readonly agentWarning?: string;
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
	| { readonly type: 'newChat' }
	| { readonly type: 'setMode'; readonly mode: ChatMode }
	| { readonly type: 'approve'; readonly stepId: string; readonly decision: 'run' | 'always' | 'skip' }
	| { readonly type: 'reviewChange'; readonly turnId: string; readonly path: string }
	| { readonly type: 'undoChanges'; readonly turnId: string };
