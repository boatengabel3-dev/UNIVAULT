import fs from 'fs';
import path from 'path';

const srcDir = path.resolve(process.cwd(), 'univault');
const distDir = path.resolve(process.cwd(), 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(srcDir, distDir, { recursive: true, force: true });

const configPath = path.join(distDir, 'config.js');
if (fs.existsSync(configPath)) {
  let content = fs.readFileSync(configPath, 'utf8');
  const envUrl = process.env.SUPABASE_URL?.trim();
  const envAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const envPaystackKey = process.env.PAYSTACK_PUBLIC_KEY?.trim();

  const overrides = [];
  if (envUrl) overrides.push(`C.SUPABASE_URL = ${JSON.stringify(envUrl)};`);
  if (envAnonKey) overrides.push(`C.SUPABASE_ANON_KEY = ${JSON.stringify(envAnonKey)};`);
  if (envPaystackKey) overrides.push(`C.PAYSTACK_PUBLIC_KEY = ${JSON.stringify(envPaystackKey)};`);

  if (overrides.length > 0) {
    content = content.replace(
      'const isValidSupabaseUrl =',
      `${overrides.join('\n')}\nconst isValidSupabaseUrl =`
    );
    fs.writeFileSync(configPath, content, 'utf8');
  }
}
