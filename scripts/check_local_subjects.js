// scripts/check_local_subjects.js
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function countSubjects(dbPath) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve({ dbPath, ok:false, error: err.message });
    });

    db.get("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='subjects'", (e1, row1) => {
      if (e1 || !row1 || row1.c === 0) {
        db.close(()=>resolve({ dbPath, ok:true, hasSubjectsTable:false, count:null }));
        return;
      }

      db.get("SELECT COUNT(*) AS c FROM subjects", (e2, row2) => {
        db.close(()=> {
          if (e2) return resolve({ dbPath, ok:false, error: e2.message, hasSubjectsTable:true });
          resolve({ dbPath, ok:true, hasSubjectsTable:true, count: row2.c });
        });
      });
    });
  });
}

(async () => {
  const files = [
    path.join(process.cwd(), 'data.sqlite'),
    path.join(process.cwd(), 'facultad.sqlite'),
    path.join(process.cwd(), 'sessions.sqlite'),
  ];

  for (const f of files) {
    const r = await countSubjects(f);
    console.log('---');
    console.log(f);
    console.log(r);
  }
})();
