import pg from 'pg';

const pool = process.env.EXAMS_DATABASE_URL ? new pg.Pool({
  connectionString: process.env.EXAMS_DATABASE_URL, max: 4,
  connectionTimeoutMillis: 10000, statement_timeout: 15000
}) : null;
pool?.on('error', () => console.warn('Se ha cerrado una conexión inactiva a la base de exámenes.'));
let schema;

export function validExamChanges(value) {
  if (!Array.isArray(value) || value.length > 100) return false;
  const ids = new Set();
  return value.every(change => {
    if (typeof change?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(change.id) || ids.has(change.id)) return false;
    ids.add(change.id);
    if (change.removed === true) return true;
    return typeof change.title === 'string' && change.title.trim().length > 0 && change.title.length <= 100 &&
      typeof change.course === 'string' && change.course.length <= 80 && typeof change.date === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(change.date) && Number.isFinite(Date.parse(change.date));
  });
}

export async function syncExams(account, changes) {
  if (!pool) throw new Error('Almacenamiento de exámenes pendiente de configurar.');
  schema ??= pool.query(`CREATE TABLE IF NOT EXISTS agenda_exams (
    account_id text NOT NULL, id text NOT NULL, title text, course text, due timestamptz,
    removed boolean NOT NULL DEFAULT false, PRIMARY KEY (account_id, id)
  )`).catch(error => { schema = undefined; throw error; });
  await schema;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (changes.length) {
      // A deletion wins even if an offline device later retries its original creation.
      const rows = changes.map(item => item.removed === true ? { id: item.id, removed: true } :
        { id: item.id, title: item.title.trim(), course: item.course.trim(), due: item.date, removed: false });
      await client.query(`INSERT INTO agenda_exams (account_id, id, title, course, due, removed)
        SELECT $1, id, title, course, due, removed FROM jsonb_to_recordset($2::jsonb)
        AS exam(id text, title text, course text, due timestamptz, removed boolean) ORDER BY id
        ON CONFLICT (account_id, id) DO UPDATE SET title=NULL, course=NULL, due=NULL, removed=true
        WHERE EXCLUDED.removed AND NOT agenda_exams.removed`, [account, JSON.stringify(rows)]);
    }
    const result = await client.query(`SELECT id, title, course, due AS date, 'exam' AS kind
      FROM agenda_exams WHERE account_id=$1 AND NOT removed ORDER BY due, id`, [account]);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
