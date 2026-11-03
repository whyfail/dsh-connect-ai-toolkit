# Third-party references and dependencies

This plugin is an independent implementation that connects to AI-Toolkit's existing local proxy. It does not bundle AI-Toolkit, or copy its platform authentication and account adapters.

## Design reference

[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy), MIT, Copyright (c) 2026 LaoDing, informed the provider connector workflow and the use of DSH's bundle/client registration APIs. The implementation here targets the public DSH interfaces and contains no copied WorkBuddy authentication, credits, account-pool, or upstream protocol implementation.

## Runtime dependencies

| Project | Role | License |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-*`) | Host model, web server, settings, and client slot interfaces | MIT |
| [Cordis](https://github.com/cordiverse/cordis) (`@deepseek-ai/cordis`) | DSH plugin service lifecycle | MIT |
| Schemastery (`@deepseek-ai/schemastery`) | DSH configuration schema interface | MIT |
| [React](https://github.com/facebook/react) | Settings UI | MIT |
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`, via DSH) | OpenAI-compatible model transport | MIT |
| [keyring-node](https://github.com/Brooooooklyn/keyring-node) (`@napi-rs/keyring`, optional) | Read-only access to AI-Toolkit's proxy credential | MIT |

Host packages and React are external to the client bundle. Dependencies and their transitive dependencies retain their own copyright and license terms. See their installed package metadata and license files for the authoritative notices.

AI-Toolkit and the model/platform names belong to their respective maintainers and owners. Mentioning them identifies the integration target and available sources, without implying official endorsement.

## Bundled brand artwork

The following original artwork is copied from the local AI-Toolkit source tree and bundled for offline identification. No remote image service is contacted. Platform logos and trademarks remain the property of their respective owners; the plugin's MIT license does not relicense those marks.

| File | Source and ownership |
| --- | --- |
| `icons/ai-toolkit.png` | AI-Toolkit production `src-tauri/icons/128x128@2x.png`, from [whyfail/AI-Toolkit](https://github.com/whyfail/AI-Toolkit), Copyright © 2026 吴磊 (whyfail), MIT |
| `icons/workbuddy.svg` | AI-Toolkit `src/assets/agents/workbuddy.svg`, originally from the [WorkBuddy official site](https://www.workbuddy.ai/) |
| `icons/qoder.svg` | AI-Toolkit `src/assets/agents/qoder.svg`, originally from the [Qoder CN official site](https://qoder.com.cn/) |
| `icons/trae.png` | AI-Toolkit `src/assets/agents/trae.png`, originally from the [TRAE CN official site](https://www.trae.cn/) |

AI-Toolkit's `src/assets/agents/README.md` records the original platform artwork URLs. Logos retain their original design and colors.

## Read-only credential discovery audit

The discovery code uses only the ordinary `AsyncEntry(service, account)` constructor and `getSecret()`. No credential write, deletion, migration, or enumeration API is called. The following upstream implementation sources were reviewed for version 2.1.2; its [published source lockfile](https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/Cargo.lock) resolves the Apple store to 1.0.2 and Windows store to 1.1.0:

- [keyring-node: AsyncEntry construction and secret reads](https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/src/async_entry.rs) and [platform entry construction](https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/src/entry_builder.rs). Ordinary construction builds an entry descriptor. The explicit-target Windows path writes a placeholder, so discovery deliberately never calls `withTarget`.
- [apple-native-keyring-store 1.0.2: keychain backend](https://docs.rs/crate/apple-native-keyring-store/1.0.2/source/src/keychain.rs). Store/entry construction creates in-memory descriptors; `get_secret` uses a generic-password lookup. A missing entry is not created. Operating-system authorization UI or access-control bookkeeping is distinct from modifying the credential value.
- [windows-native-keyring-store 1.1.0: store construction](https://docs.rs/crate/windows-native-keyring-store/1.1.0/source/src/store.rs), [credential descriptors](https://docs.rs/crate/windows-native-keyring-store/1.1.0/source/src/cred.rs), and [native reads](https://docs.rs/crate/windows-native-keyring-store/1.1.0/source/src/utils.rs). Ordinary construction does not create a stored credential; its empty prefix/suffix and dot divider produce `account.service`, matching [AI-Toolkit's keyring 3.6.3 Windows backend](https://docs.rs/crate/keyring/3.6.3/source/src/windows.rs). Discovery reads raw secret bytes rather than UTF-16 password strings.

On macOS, AI-Toolkit stores several entries in a single shared vault record. Discovery must read that record to extract `gateway-api-key`, but does not enumerate its other entries, use platform-account values, or persist the record. Legacy layouts are read only at the proxy manifest and the exact chunk names it declares.

SQLite connections use `readOnly` plus `query_only` and do not update SQL data or attempt repairs. Existing WAL content remains visible. Discovery checks the database header's read/write format versions before opening SQLite and requires both existing WAL and SHM files when the header indicates WAL mode; this also rejects cleanly closed WAL databases whose sidecars have disappeared. The checks are not an atomic lock against concurrent changes by the owning app. SQLite may maintain an existing SHM index, so discovery does not promise unchanged SHM bookkeeping bytes.
