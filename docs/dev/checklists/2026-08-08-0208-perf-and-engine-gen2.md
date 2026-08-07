# Perf + engine gen-2 - checklist

Spec: docs/dev/specs/2026-08-08-0208-perf-and-engine-gen2-design.md

- [ ] 0. Data refreshed (full sweep; background)
- [ ] A1. Perf audit: measure current cold/warm/bytes on the hot endpoints
- [ ] A2. Server caching mods (data_version idiom on remaining hot reads; static asset headers)
- [ ] A3. Payload slimming decisions executed (guest market tail, details-tier AI JSON)
- [ ] A4. Before/after measurements recorded
- [ ] B1. Hit-vs-miss pattern diagnosis over settled tips + daily-slip timeline
- [ ] B2. Contradiction audit (same-fixture O/U opposites across surfaces) + fix design
- [ ] B3. Gen-2 harness: >= 100 walk-forward generations, error feedback, top-3 safest markets @ >= 1.5 odds objective
- [ ] B4. Owner checkpoint: patterns + proposed overhaul approved
- [ ] B5. Bake approved changes; suite green; honest replay report
- [ ] B6. UI/UX: winning path obvious - tier ladder (aim 5x / 3x / 2x / 1.5x floor), survival+profit sorting surfaced (owner directive mid-session)
- [ ] B7. API-Football: transient-403 exponential backoff before permanent failure (observed 403-then-success on stats pulls); header-guarded usage
- [ ] B8. API-Football: audit unused subscription stats for engine enrichment; wire what replay proves
- [ ] C1. Docs synced (CLAUDE.md/QUICK-REFERENCE/engine chapters as touched)
- [ ] C2. OWNER GREEN LIGHT -> stop live server warning -> deploy (--db --app --web) -> restart -> smoke
- [ ] C3. Re-tag commit head (owner's tag/bump call)
