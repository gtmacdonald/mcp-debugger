import { Pool } from 'pg';

const pool = new Pool({
    database: 'bug_reports',
    // Assuming default local config for now
});

export async function saveReport(severity: string, description: string, context: any) {
    const client = await pool.connect();
    try {
        await client.query(
            'INSERT INTO reports (severity, description, context) VALUES ($1, $2, $3)',
            [severity, description, context]
        );
    } finally {
        client.release();
    }
}

export async function getReports() {
    const client = await pool.connect();
    try {
        const res = await client.query('SELECT * FROM reports ORDER BY created_at DESC');
        return res.rows;
    } finally {
        client.release();
    }
}
