# Meridian

Meridian is the name and look of this fork: floating, rounded panels on a dark canvas, Geist and Geist Mono for text and code, Instrument Serif for the few words that should feel like a greeting, and three themes. The design comes from the Meridian artboard (workspace, omnibar and welcome screens). This page lists where each part lives so it can be changed without hunting.

The repository, the `~/.fork` config folder and the `forkAi.*` setting and command ids keep their names. Window titles, the About box, the title bar wordmark and the welcome page say Meridian; the AI is called the Companion.

## Themes

| Theme | Canvas | Accent | Second accent |
| --- | --- | --- | --- |
| Meridian Nocturne (the dark default) | `#0A0C13` | `#8F82FF` | `#5FE3C9` |
| Meridian Ember | `#110D0B` | `#FF8F60` | `#F4C86A` |
| Meridian Porcelain (the light default) | `#E6E2DC` | `#4A3FD6` | `#0B7A68` |

The themes are generated: edit the palette in `extensions/theme-meridian/generate-themes.mts` and run `node extensions/theme-meridian/generate-themes.mts`. Besides the usual VS Code colors they set Meridian's own roles (`meridian.accent`, `meridian.panel`, `meridian.line`, `meridian.textMuted` and the rest, registered in `src/vs/workbench/common/theme.ts`), which the workbench CSS and the Companion's chat use. Any other theme gets sensible fallbacks.

## The workbench

| What | Where |
| --- | --- |
| Fonts, radii, the floating panels, tabs, tree rows, menus, scrollbars | `src/vs/workbench/browser/media/meridian.css`, fonts in `src/vs/workbench/browser/media/fonts/` (SIL Open Font License) |
| Title bar: the globe and wordmark, the centered search, the model pill, Share and the avatar | `parts/titlebar/titlebarPart.ts`, `commandCenterControl.ts`, `contrib/meridian/browser/titleBarControls.ts` |
| The Space header (SPACE, the project name, Files / Changes / Outline, Pinned) | `parts/sidebar/spaceHeader.ts` |
| Omnibar: All / Files / Commands / Ask tabs, ⌘⏎ asks the Companion | `contrib/meridian/browser/omnibar.ts` and the quick access changes in `contrib/search/browser/anythingQuickAccess.ts` |
| Time scrub under the editor: the file's local history, one mark per save | `contrib/meridian/browser/timeScrub.ts`, hooked in through `parts/editor/editorGroupFooter.ts` |
| SCRIPTS chips above the terminal: the workspace's `package.json` scripts, run with the package manager the lockfile names | `contrib/meridian/browser/scriptsBar.ts`, hooked in through `contrib/terminal/browser/terminalViewHeader.ts` |
| The warning dot after unsaved files | `contrib/meridian/browser/unsavedDecorations.ts` |
| Welcome: the greeting, Open folder / Clone / New Space, recent Spaces, theme, model and settings import | `contrib/meridian/browser/welcome.ts`, `importSettings.ts`; it replaces Getting Started as the startup page through `StartupWelcomeOverride` in `contrib/welcomeGettingStarted/browser/startupPage.ts` |

Rules that are easy to test (which scripts a `package.json` has, what the import brings over, the greeting) are in `contrib/meridian/common/` with tests in `contrib/meridian/test/common/`.

Settings: `meridian.editor.timeScrub` and `meridian.terminal.scripts` turn the time scrub and the Scripts row off. Commands: **Meridian Welcome** (Help), **Meridian: New Space**, **Meridian: Import Settings from Another Editor**.

### Bring your settings

The import reads VS Code, VS Code Insiders, Cursor, Windsurf or VSCodium on the same computer. It adds the settings Meridian does not have yet (leaving out the other editor's theme, fonts and its own AI settings), appends keybindings Meridian does not already have, and installs extensions that are not installed, from Meridian's marketplace. Nothing in Meridian is overwritten. It works in the desktop app, where it can read the other editor's files.

## The Companion

The Companion is the `fork-ai` built-in extension (see its README). For Meridian it sets the context keys the title bar reads (`forkAi.ready`, `forkAi.chatModelName`, `meridian.userName`, `meridian.userInitials`; the name comes from git's `user.name`, else the OS account), shows **● Ready** in the status bar, and adds the commands the workbench calls: `forkAi.pickChatModel`, `forkAi.shareChat` (the chat as Markdown, copied) and `forkAi.askCompanion` (`{ text, withActiveFile, withCodebase, mode }`, used by the omnibar's Ask tab). The chat itself follows the artboard: your messages as bubbles, the agent's plan as a checklist card (from its `update_plan` tool), changed files in a card with **Review changes** (one multi-file diff), and a composer with Agent and model pills, attach and a round send button.
