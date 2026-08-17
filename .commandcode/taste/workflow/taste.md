# Taste

## Workflow

- When asked to continue/resume work ("continua por donde se ha quedado"), expects the agent to dig into the previous session's storage (e.g. opencode SQLite DB) to reconstruct the full context and pick up exactly where it left off, instead of asking the user to re-explain the task. Confidence: 0.8
- Tracks progress across multiple related repos (checking git status/branch/log of each) before deciding what is done, what is pending, and what belongs to other sessions. Confidence: 0.7
- Wants to be explicitly asked before pushing branches destined for production (e.g. iptv-api feature/torrentio-prod); authorizes with a terse confirmation ("si pushea") and handles the final deployment config step (e.g. switching the branch in Dokploy) himself. Confidence: 0.6
- For UI changes, expects HTML mockups (several variants, e.g. inline vs modal) created and opened in the browser for review before touching the real screens. Confidence: 0.7
