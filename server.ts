import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const port = Number(process.env.PORT) || 3000;

const univaultDir = path.resolve(process.cwd(), 'univault');
const distDir = path.resolve(process.cwd(), 'dist');
const staticDir = fs.existsSync(univaultDir) ? univaultDir : distDir;

app.get('/config.js', (_req, res) => {
  const configPath = path.join(staticDir, 'config.js');
  if (!fs.existsSync(configPath)) {
    res.status(404).end();
    return;
  }

  let content = fs.readFileSync(configPath, 'utf8');
  const envUrl = process.env.SUPABASE_URL?.trim();
  const envAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const envPaystackKey = process.env.PAYSTACK_PUBLIC_KEY?.trim();

  const overrides: string[] = [];
  if (envUrl) overrides.push(`C.SUPABASE_URL = ${JSON.stringify(envUrl)};`);
  if (envAnonKey) overrides.push(`C.SUPABASE_ANON_KEY = ${JSON.stringify(envAnonKey)};`);
  if (envPaystackKey) overrides.push(`C.PAYSTACK_PUBLIC_KEY = ${JSON.stringify(envPaystackKey)};`);

  if (overrides.length > 0) {
    content = content.replace(
      'const isValidSupabaseUrl =',
      `${overrides.join('\n')}\nconst isValidSupabaseUrl =`
    );
  }

  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript').send(content);
});

app.use(express.static(staticDir));

app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    res.status(404).end();
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`UniVault server listening on http://0.0.0.0:${port}`);
});
