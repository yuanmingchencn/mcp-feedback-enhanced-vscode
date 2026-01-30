#!/usr/bin/env node
/**
 * Migrate history from JSON files to SQLite
 * 
 * Usage:
 *   node scripts/migrate-history.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const HISTORY_DIR = path.join(os.homedir(), '.config', 'mcp-feedback-enhanced', 'history');
const DB_FILE = path.join(HISTORY_DIR, 'history.db');

console.log('='.repeat(60));
console.log('MCP Feedback Enhanced - History Migration');
console.log('='.repeat(60));
console.log(`History directory: ${HISTORY_DIR}`);
console.log(`Database file: ${DB_FILE}`);
console.log('');

// Create/open database
const db = new Database(DB_FILE);

// Create table
db.exec(`
    CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        images TEXT,
        workspace TEXT,
        project_directory TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workspace ON history(workspace);
    CREATE INDEX IF NOT EXISTS idx_project_directory ON history(project_directory);
`);

console.log('Database initialized.');

// Prepare insert statement
const insertStmt = db.prepare(`
    INSERT INTO history (role, content, timestamp, images, workspace, project_directory)
    VALUES (?, ?, ?, ?, ?, ?)
`);

// Import all JSON files
const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
let totalImported = 0;
let fileCount = 0;

for (const file of files) {
    const filePath = path.join(HISTORY_DIR, file);
    
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const messages = JSON.parse(content);
        
        if (!Array.isArray(messages)) {
            console.log(`  Skipping ${file}: not an array`);
            continue;
        }
        
        let imported = 0;
        
        // Use a transaction for better performance
        const importMessages = db.transaction((msgs) => {
            for (const msg of msgs) {
                if (!msg.role || !msg.content) continue;
                
                insertStmt.run(
                    msg.role,
                    msg.content,
                    msg.timestamp || new Date().toISOString(),
                    msg.images ? JSON.stringify(msg.images) : null,
                    msg.workspace || null,
                    msg.project_directory || null
                );
                imported++;
            }
        });
        
        importMessages(messages);
        
        console.log(`  Imported ${imported} messages from ${file}`);
        totalImported += imported;
        fileCount++;
        
    } catch (e) {
        console.error(`  Error processing ${file}: ${e.message}`);
    }
}

console.log('');
console.log('-'.repeat(60));
console.log(`Migration complete!`);
console.log(`  Files processed: ${fileCount}`);
console.log(`  Messages imported: ${totalImported}`);
console.log('');

// Show summary
const countStmt = db.prepare('SELECT COUNT(*) as count FROM history');
const { count } = countStmt.get();
console.log(`Total records in database: ${count}`);

// Close database
db.close();

console.log('');
console.log('You can now delete the JSON files:');
console.log(`  rm ${HISTORY_DIR}/*.json`);
