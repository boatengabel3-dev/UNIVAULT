UniVault setup
1. Supabase: run schema.sql. Authentication > Providers: enable Email.
2. Fill keys in config.js (Supabase URL, anon key, Paystack public key).
3. Deploy: supabase functions deploy ai-chat paystack-verify admin-payout public-stats
4. Secrets: supabase secrets set ANTHROPIC_API_KEY=... PAYSTACK_SECRET_KEY=sk_...
5. Make admins: sign up, copy your user id (Authentication > Users), then in SQL: insert into admins(user_id) values('UUID');
   The admin page is /admin.html. Nothing links to it and non-admins are redirected; real protection is server-side.
6. Put the official KNUST logo at assets/knust-logo.png (a placeholder shield shows until then).
7. Paystack: enable Transfers (Ghana mobile money) and keep balance in your Paystack account for payouts.
Money flow: users pay GH₵30/month; approved uploads credit GH₵3 to the uploader's wallet; withdrawals min GH₵10.
