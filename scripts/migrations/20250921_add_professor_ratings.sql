-- Tabla de calificaciones por profesor/usuario
CREATE TABLE IF NOT EXISTS professor_ratings (
  id            BIGSERIAL PRIMARY KEY,
  professor_id  BIGINT NOT NULL,
  user_id       BIGINT NOT NULL,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 0 AND 5),
  corr          INTEGER NOT NULL CHECK (corr BETWEEN 1 AND 10),
  clases        INTEGER NOT NULL CHECK (clases BETWEEN 1 AND 10),
  onda          INTEGER NOT NULL CHECK (onda BETWEEN 1 AND 10),
  comment       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un usuario solo puede tener UNA calificación por profesor
CREATE UNIQUE INDEX IF NOT EXISTS uq_professor_ratings_prof_user
ON professor_ratings (professor_id, user_id);

-- (Opcional) índices de ayuda
CREATE INDEX IF NOT EXISTS idx_professor_ratings_professor
ON professor_ratings (professor_id);

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS professor_ratings_touch_updated_at ON professor_ratings;
CREATE TRIGGER professor_ratings_touch_updated_at
BEFORE UPDATE ON professor_ratings
FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();
