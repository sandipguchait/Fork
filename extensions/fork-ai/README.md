# Fork AI

Fork's built-in AI: chat, inline edits, an agent with MCP tools and a sandbox, and codebase search, all with your own models. Every request goes straight from the editor to the endpoint you configured, and nothing passes through a Fork server.

## Use it

1. Press **Cmd+L** (Ctrl+L), or run **Fork AI: Add Model** from the Command Palette.
2. Pick a provider (OpenRouter, Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, Ollama, LM Studio) or **Custom endpoint**.
3. Confirm the endpoint URL, paste the API key, then pick the model from the provider's list or type its name.
4. Fork tests the connection (key, streaming, tool calling) and saves the model.

In the chat:

- The **open file**, and your selection in it, are sent with each message. Click the file's chip to leave it out.
- **Cmd+L** with code selected adds that selection to the chat. **@** or **Add context** adds any file, or **Codebase** (below).
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

## Agent mode

Switch the chat's **Ask / Agent** menu to **Agent** and describe a task, for example "fix the failing test in dates.ts". The agent works step by step with these tools:

| Tool | What it does | Asks first? |
| --- | --- | --- |
| `read_file`, `list_files`, `search` | Reads, lists and searches the project; skips `node_modules`, `.git` and build output | No |
| `codebase_search` | Finds code by what it does, from the codebase index (below) | No |
| `edit_file`, `create_file` | Exact-text edits and new files, saved so tests see them | No; every file is checkpointed first |
| `run_command` | Runs a shell command in the project root, 120 s limit, in a sandbox where available (below) | Yes, except read-only basics (`git status`, `ls`, `cat` …) and commands you chose **Always allow** for |
| MCP tools (`mcp__<server>__<tool>`) | Whatever your MCP servers offer (below) | Yes, except tools you chose **Always allow** for or listed in `autoApprove` |

- Each step appears as a card; click a card to see its output.
- Commands that look destructive (`rm -rf`, `sudo`, `git push --force`, `git reset --hard`, piping a download into a shell, and similar) always ask, with no **Always allow**.
- Commands that chain others (`;`, `&&`, `|`) ask unless you allowed that exact command.
- When the turn ends, **Changed N files** lists each file with its line counts. Click a file to see a diff against the checkpoint; **Undo all** puts every file back, and files the agent created go to the trash. Changes made by commands themselves, such as a code generator, are not checkpointed.
- **Stop** ends the run at once; a command waiting for approval is skipped.
- Rules in `.fork/rules.md`, `AGENTS.md` or `.cursorrules` (first one found) are added to the instructions, in Ask mode too.
- Agent mode needs a model that passed the tool-calling test when it was added. If it failed, the chat warns you.
- The agent stops after 25 steps; send another message to let it continue.

- File tools stay inside the project: a path through a symlink that leads outside (to `~/.ssh`, another project) is refused, for reading as well as writing.

## MCP servers

The agent can use the tools of any [Model Context Protocol](https://modelcontextprotocol.io) server. Servers go in `~/.fork/mcp.json` (every project) or `.fork/mcp.json` (this project), in the same format as Cursor's and Claude Desktop's `mcp.json`, so an existing file can be copied as it is:

```jsonc
{
	"mcpServers": {
		// A local server: a program Fork starts and talks to over stdin/stdout.
		"git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "${workspaceFolder}"], "autoApprove": ["git_status"] },
		// A remote server, over Streamable HTTP (or the older SSE transport, found automatically).
		"github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer ${env:GITHUB_TOKEN}" } }
	}
}
```

- `${env:NAME}`, `${workspaceFolder}` and `${userHome}` are filled in. Other keys: `env` and `cwd` for local servers, `timeout` (ms per call, default 120 s), `disabled`, `autoApprove` (tools that run without asking).
- **Fork AI: MCP Servers** (the plug button in the chat's title bar) lists each server with its status and tools, and restarts it, turns it off for this workspace, or opens the config or the log.
- **Project servers ask first.** A `.fork/mcp.json` runs commands from the repository, so Fork shows each command and starts it only after you say **Start**, and only in a trusted workspace. It asks again whenever the command changes. Servers in `~/.fork/mcp.json` start without asking.
- Each tool call asks before it runs, with the arguments shown; **Always allow** remembers that tool for this project. Servers that crash restart up to three times.
- Results come back as text. Images and binary resources become a short note, since not every provider accepts them in tool results.
- Fork speaks both MCP eras: the 2025 initialize handshake that servers use today, and the stateless 2026-07-28 revision for servers that only speak that. Sampling, elicitation and OAuth sign-in are not supported yet; remote servers that need a token take it in `headers`.

## Sandbox

On macOS (Seatbelt, built in) and on Linux with [bubblewrap](https://github.com/containers/bubblewrap) installed, the agent's commands run in a sandbox. They can read files anywhere but write only inside the project, the temp folder and package caches (`~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.cargo/registry` and similar), so `npm install`, builds and tests work while `~/.zshrc`, `~/.ssh` and your other projects stay out of reach. A blocked write fails with "Operation not permitted" or "Read-only file system", and the agent is told why.

- **forkAi.agent.sandbox**: `auto` (default) or `off`.
- **forkAi.agent.sandboxAllowWrite**: the folders outside the project that commands may write to.
- **forkAi.agent.sandboxNetwork**: turn off to cut sandboxed commands off from the network.

The sandbox is in addition to the approval prompts, not instead of them. On Windows, and on Linux without bubblewrap, commands run unsandboxed as before. MCP servers are not sandboxed: they are programs you chose to run. `node --test test/sandbox.test.ts` tries to escape the sandbox on your computer (writing to the home folder, through `../`, symlinks and a shell profile, with the network off) and checks that each attempt fails.

## Codebase search

Fork indexes the open folder in the background, so the agent and chat can find code without being told where it is. The status bar shows progress (**Indexing 1,200/4,800**), then the file count; click it for options.

- **Keyword search, always on and free.** A local index that understands code: `parseDate`, `parse_date` and "parse dates" all match, file and folder names count, and tests rank below the code they test. Nothing leaves your computer.
- **Search by meaning, optional.** Choose an embedding model (**Fork AI: Choose Embedding Model**, the status bar, or **Codebase search…** in Manage Models) and Fork also embeds every chunk of code, then ranks results by keywords and meaning together. Ollama with `nomic-embed-text` is free and local (`ollama pull nomic-embed-text`); OpenAI, Gemini, Mistral, LM Studio and any OpenAI-compatible endpoint work too. A cloud embedding model receives your code. Embeddings are cached on disk by content, so restarts and reindexing only embed what changed.
- **In chat**, pick **Codebase** from **@** / **Add context**, or type `@codebase`. Fork searches for your message and sends the best matching snippets with it (the chip says how many).
- **In Agent mode**, the agent calls `codebase_search` itself.

What gets indexed: the first workspace folder, following `.gitignore` and `.forkignore` (same syntax; **Fork AI: Edit .forkignore**), skipping `node_modules`, build output, binaries, lock files and minified code. The index updates as files change. Settings under **Fork AI › Index** set the limits: 15,000 files, 512 KB per file and 100 MB of text by default. Source files are indexed before docs, config and tests, so the limits drop the least useful files first. The index lives in memory, about twice the size of the text indexed. **forkAi.index.enabled** turns it off.

On the Fork source itself (VS Code, about 20,000 files) with the default limits, keyword search alone puts the right file in the top 5 for 15 of 20 "where is X" questions (`node fork/dev/eval-where-is.ts --limits`). Ten of those questions were used to tune the ranking and ten were not; on those ten it gets 7.

## Where things are stored

| What | Where |
| --- | --- |
| API keys | The OS keychain, via VS Code's SecretStorage |
| Model settings (URL, model name, format) | Global extension storage, shared across workspaces |
| Chats | Workspace storage, the newest 50 per project |
| Agent checkpoints | Memory only: **Undo all** works until the window reloads |
| Commands and MCP tools you chose **Always allow** for, trusted project MCP servers, and the Ask/Agent choice | Workspace storage, per project |
| MCP servers | `~/.fork/mcp.json` and `.fork/mcp.json`, edited by you |
| Codebase index | Memory only, rebuilt when the window opens |
| Embeddings | Workspace storage, one cache file per embedding model, holding only vectors of code still in the project |

## Layout

| Path | What |
| --- | --- |
| `src/extension.ts` | Activation and commands |
| `src/chatView.ts` | The chat webview provider: context, streaming, history, Insert/Copy |
| `src/agent/` | Agent mode: tools and approvals, the loop, workspace tools and checkpoints, the sandbox and the workspace boundary, one agent turn |
| `src/mcp/` | MCP: config parsing, tool naming and results, the protocol client (stdio, Streamable HTTP, SSE; both eras), the server manager and its panel |
| `src/index/` | Codebase search: tokenizer, chunker, ignore rules and BM25 + vector index (pure, unit-tested); the indexing service, embedding cache, status bar |
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
