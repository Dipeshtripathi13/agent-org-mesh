-- 0004 — the runtime catalog is shared by every organization, but some entries still described
-- the original demo company's own setup ("Northbeam tenant · us-east-1", "Org default.
-- Enterprise agreement covers zero-retention inference."), which every new signup was shown as if
-- it were true of them. Replace with vendor-neutral descriptions.

UPDATE runtime_catalog SET host = 'Anthropic''s cloud',
  note = 'Answers through Anthropic''s API — the platform''s shared key unless you add your own.'
  WHERE key = 'claude-sonnet';
UPDATE runtime_catalog SET host = 'OpenAI''s cloud' WHERE key = 'chatgpt';
UPDATE runtime_catalog SET host = 'Mistral AI''s cloud' WHERE key = 'mistral';
UPDATE runtime_catalog SET host = 'Google''s cloud' WHERE key = 'gemini';
