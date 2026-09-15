-- 0005 — Claude Code, Codex and Gemini CLI start as "not connected", like every other tool.
--
-- New people used to get these three as 'outOfScope' ("doesn't apply to this role"). Nothing
-- ever set that deliberately — it was only the default — but since pushes to out-of-scope
-- tools are refused (2026-09-14), it meant nobody in an organization could connect Claude Code
-- or Codex. Found 2026-09-15: in production, every 'outOfScope' value was one of these three
-- defaults. People who already connected one ('connected' and the rest) are left alone.

UPDATE people SET surfaces = jsonb_set(surfaces, '{claude-code}', '"absent"')
  WHERE surfaces->>'claude-code' = 'outOfScope';
UPDATE people SET surfaces = jsonb_set(surfaces, '{codex}', '"absent"')
  WHERE surfaces->>'codex' = 'outOfScope';
UPDATE people SET surfaces = jsonb_set(surfaces, '{gemini-cli}', '"absent"')
  WHERE surfaces->>'gemini-cli' = 'outOfScope';
