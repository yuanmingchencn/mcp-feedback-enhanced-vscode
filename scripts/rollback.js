const fs = require('fs');
const path = require('path');

const backupDir = path.join(__dirname, '..', 'out', 'webview', 'backups');
const panelPath = path.join(__dirname, '..', 'out', 'webview', 'panel.html');

// List available backups
const backups = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.html'))
    .sort()
    .reverse();

if (process.argv[2] === 'list') {
    console.log('Available backups:');
    backups.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(0);
}

if (process.argv[2] === 'restore') {
    const index = parseInt(process.argv[3]) - 1;
    if (isNaN(index) || index < 0 || index >= backups.length) {
        console.log('Usage: node scripts/rollback.js restore <number>');
        console.log('Run "node scripts/rollback.js list" to see available backups');
        process.exit(1);
    }
    const backup = backups[index];
    fs.copyFileSync(path.join(backupDir, backup), panelPath);
    console.log(`Restored: ${backup}`);
    process.exit(0);
}

if (process.argv[2] === 'save') {
    const name = process.argv[3] || `panel-${Date.now()}`;
    const dest = path.join(backupDir, `${name}.html`);
    fs.copyFileSync(panelPath, dest);
    console.log(`Saved: ${name}.html`);
    process.exit(0);
}

console.log('Usage:');
console.log('  node scripts/rollback.js list              - List backups');
console.log('  node scripts/rollback.js save [name]       - Save current version');
console.log('  node scripts/rollback.js restore <number>  - Restore a backup');
