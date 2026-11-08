# Declare Horizon Contracts in a `horizon.yml` Sidecar, Not SKILL.md Frontmatter

The hand-off placed `horizon_contract` in SKILL.md YAML frontmatter. sec-skills are written to be tool-agnostic, and OMP's Agent Plugins loader enforces a closed frontmatter field set that would reject the key, so each skill instead declares its contract in `horizon.yml` beside `SKILL.md`, read via `skill://<name>/horizon.yml`. This also gives trace-reflect a plain YAML target to patch instead of rewriting frontmatter embedded in hand-maintained Markdown.
