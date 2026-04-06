BEGIN;

-- Para cada (career, plan, name) conservar el MIN(id) como canonical
CREATE TEMP TABLE dedup_map AS
WITH d AS (
  SELECT career, plan, name, MIN(id) AS keep_id
  FROM subjects
  GROUP BY career, plan, name
)
SELECT s.id AS old_id, d.keep_id
FROM subjects s
JOIN d ON d.career = s.career AND d.plan = s.plan AND d.name = s.name
WHERE s.id != d.keep_id;

-- Actualizar FKs
UPDATE correlatives
SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = correlatives.subject_id)
WHERE subject_id IN (SELECT old_id FROM dedup_map);

UPDATE correlatives
SET depends_on_id = (SELECT keep_id FROM dedup_map WHERE old_id = correlatives.depends_on_id)
WHERE depends_on_id IN (SELECT old_id FROM dedup_map);

UPDATE group_members
SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = group_members.subject_id)
WHERE subject_id IN (SELECT old_id FROM dedup_map);

UPDATE group_messages
SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = group_messages.subject_id)
WHERE subject_id IN (SELECT old_id FROM dedup_map);

-- Si existe 'documents'
UPDATE documents
SET subject_id = (SELECT keep_id FROM dedup_map WHERE old_id = documents.subject_id)
WHERE subject_id IN (SELECT old_id FROM dedup_map);

-- Borrar duplicados
DELETE FROM subjects WHERE id IN (SELECT old_id FROM dedup_map);

-- Índice único para prevenir duplicados
CREATE UNIQUE INDEX IF NOT EXISTS ux_subjects_unique ON subjects(career, plan, name);

COMMIT;