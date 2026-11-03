# Fork dev tools

| File | What it does |
| --- | --- |
| `try-fork.sh` | Installs, compiles and launches Fork with a fake local model. Run `bash fork/dev/try-fork.sh`; add `--rebuild` after pulling new commits. It logs to `.build/try-fork.log`. |
| `fake-model-server.mjs` | An OpenAI-compatible fake model on `http://127.0.0.1:11999/v1` (model `fake-coder`, no key). It streams canned chat answers, makes a predictable two-part change for Cmd+I and Apply, and in Agent mode runs a scripted fix of `parseDate` with a three-step plan, tests included. Model `fake-embed` on the same URL returns word-hash embeddings for trying semantic codebase search. |
| `sample-project/` | A small TypeScript project the script opens, with a deliberate bug in `parseDate` and a test (`node --test`) that catches it. |
| `eval-where-is.ts` | Measures codebase search on this repo: 20 "where is X" questions, scored by whether the right file is in the top 5. `node fork/dev/eval-where-is.ts --limits` uses Fork's default index limits; add `--embed` with `FORK_EMBED_URL` and `FORK_EMBED_MODEL` (default: Ollama's `nomic-embed-text`) to include semantic search. Embedding the whole repo takes a while. |

To try a real model instead, add it with **Companion: Add Model** and pick it in the chat's model picker.
