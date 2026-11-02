# Fork AI

Fork's built-in AI: chat and inline edits with your own models. Every request goes straight from the editor to the endpoint you configured, and nothing passes through a Fork server.

## Use it

1. Press **Cmd+L** (Ctrl+L), or run **Fork AI: Add Model** from the Command Palette.
2. Pick a provider (OpenRouter, Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, Ollama, LM Studio) or **Custom endpoint**.
3. Confirm the endpoint URL, paste the API key, then pick the model from the provider's list or type its name.
4. Fork tests the connection (key, streaming, tool calling) and saves the model.

In the chat:

- The **open file**, and your selection in it, are sent with each message. Click the file's chip to leave it out.
- **Cmd+L** with code selected adds that selection to the chat. **@** or **Add context** adds any file.
- Code blocks have **Copy** and **Insert**. Insert replaces the selection in the editor you last used.
- The model picker is in the input box. **New chat**, **History** and **Manage models** are in the view's title bar.

## Inline edits (Cmd+I)

1. Select code, or put the cursor on a line, and press **Cmd+I** (Ctrl+I). The context menu has **Edit with AI** too.
2. Describe the change. The lines being edited are highlighted; press **Esc** to cancel.
3. The change appears in place: old lines in red, new lines in green.
4. Each change has **Accept** and **Reject** above it. **Cmd+Enter** accepts all and **Cmd+Backspace** rejects all; the status bar and the editor title have the same actions.

**Apply** on a chat code block runs the same review on your selection, or on the whole file when nothing is selected (files up to 2,000 lines).

Inline edits use the chat model unless you pick one for them: in **Manage Models**, press the pencil button on a model. A fast, cheap model works well here.

Every step is an ordinary edit, so Cmd+Z works throughout. Typing inside a change stops tracking that change and leaves its lines as they are. Undoing the whole edit ends the review.

Cmd+I replaces VS Code's alternative shortcut for suggestions on macOS; Ctrl+Space still opens suggestions. Cmd+K is left alone because VS Code uses it to start many two-key shortcuts.

## Where things are stored

| What | Where |
| --- | --- |
| API keys | The OS keychain, via VS Code's SecretStorage |
| Model settings (URL, model name, format) | Global extension storage, shared across workspaces |
| Chats | Workspace storage, the newest 50 per project |

## Layout

| Path | What |
| --- | --- |
| `src/extension.ts` | Activation and commands |
| `src/chatView.ts` | The chat webview provider: context, streaming, history, Insert/Copy |
| `src/inlineEdit.ts` | Cmd+I and Apply: the prompt, the in-place red/green review, Accept and Reject |
| `src/diff.ts`, `src/editPrompt.ts` | The line diff and the edit prompt, unit-tested without VS Code |
| `src/addModel.ts`, `src/manageModels.ts` | The Add model flow and the model list |
| `src/modelStore.ts`, `src/history.ts`, `src/context.ts`, `src/presets.ts` | Pure logic, unit-tested without VS Code |
| `src/protocol.ts` | Messages between the extension and the webview |
| `webview-src/` | The chat UI (no framework) and a safe Markdown renderer |
| `../../fork/model-router` | Provider adapters, bundled into `dist/extension.js` |

## Build and test

The dev build (`npm run watch` at the repo root) bundles this extension and its webview through `esbuildMediaScripts` in `build/lib/extensions.ts`. To build or test it on its own:

```sh
node esbuild.mts && node esbuild.webview.mts   # writes dist/extension.js and dist/chat.js
node --test test/*.test.ts                     # unit tests, no install needed (Node 22.18+)
```
