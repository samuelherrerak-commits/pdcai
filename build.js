const { writeFileSync } = require('fs');
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';
writeFileSync('Config.js', `window.SUPABASE_URL = '${url}';\nwindow.SUPABASE_KEY = '${key}';\n`);
