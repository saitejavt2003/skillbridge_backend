CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  clerk_user_id TEXT UNIQUE,
  name TEXT,
  role TEXT,
  institution_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  name TEXT,
  institution_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS batch_students (
  id SERIAL PRIMARY KEY,
  batch_id INT REFERENCES batches(id) ON DELETE CASCADE,
  student_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, student_id)
);

CREATE TABLE IF NOT EXISTS batch_trainers (
  id SERIAL PRIMARY KEY,
  batch_id INT REFERENCES batches(id) ON DELETE CASCADE,
  trainer_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, trainer_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  batch_id INT,
  trainer_id INT REFERENCES users(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INT REFERENCES users(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'present',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, student_id)
);

INSERT INTO batches (id, name)
VALUES (1, 'Default Batch')
ON CONFLICT (id) DO NOTHING;

SELECT setval('batches_id_seq', (SELECT MAX(id) FROM batches));
