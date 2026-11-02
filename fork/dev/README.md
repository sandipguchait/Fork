# Fork dev tools

| File | What it does |
| --- | --- |
| `try-fork.sh` | Installs, compiles and launches Fork with a fake local model. Run `bash fork/dev/try-fork.sh`; add `--rebuild` after pulling new commits. It logs to `.build/try-fork.log`. |
| `fake-model-server.mjs` | An OpenAI-compatible fake model on `http://127.0.0.1:11999/v1` (model `fake-coder`, no key). It streams canned chat answers and makes a predictable two-part change for Cmd+I and Apply. |
| `sample-project/` | A small TypeScript project the script opens, with a deliberate bug in `parseDate`. |

To try a real model instead, add it with **Fork AI: Add Model** and pick it in the chat's model picker.
